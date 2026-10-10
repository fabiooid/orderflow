import { confirmedChoices } from '../matching/resolver.js';
import { tracingContext, traceChannelTurn } from '../assistant/execution-trace.js';
import { z } from 'zod';
import { Mastra } from '@mastra/core';
import type { RequestContext } from '@mastra/core/request-context';
import { Observability, MastraStorageExporter } from '@mastra/observability';
import type { LibSQLStore } from '@mastra/libsql';
import type { AppConfig } from '../config/schema.js';
import type { OrderConnector } from '../connector/contract.js';
import { createOrderAgent, groupMemory } from '../assistant/agent.js';
import { issuesForAgent, type DraftResult } from '../assistant/drafts.js';
import { startTurn } from '../assistant/turn-context.js';
import { reasoning } from '../assistant/reasoning.js';
import type { OrderDraft } from '../domain/types.js';
import type { Choice, ConversationEngine, TurnInput } from './controller.js';
import { appendSource, kindOf, type Conversation, type ReplyPlan } from './store.js';
import { customerPreview, existingCustomer, lineIndex, orderDraft, orderPreview } from './preview.js';
import type { MastraDBMessage } from '@mastra/core/agent';
import { evalContext, liveEvalSettings } from '../assistant/live-evals.js';
import { createDeliveredReplyWorkflow } from './evaluation.js';
import { createMediaAgents, createMediaReader, modelReader, modelVision, voiceTranscriber, type Download, type MediaReader } from './media.js';
import { documentTemplates } from './order-forms.js';
import { createDocumentWorkflow, workflowTemplatePages } from '../documents/workflow.js';
import { createVisionDocumentProvider } from '../documents/reader.js';
import { omitMedia } from '../assistant/omit-media.js';

/** What the model reads each turn, beside the shared group conversation. */
export type TurnPrompt = {
  speaker: { id: string; role: 'operator' };
  /** What the operator typed or said. */
  operatorWords: string;
  /** The whole message when it also carries content read from attachments or a forward. */
  messageWithAttachments?: string;
  openRequest: { kind: 'order' | 'customer'; status: Conversation['status']; draft: OrderDraft; openIssues: ReturnType<typeof issuesForAgent> } | null;
  otherOpenRequest?: string;
};
/** The draft tools, as a scripted stand-in for the model calls them. */
export type TurnActions = { order: (draft: OrderDraft) => Promise<unknown>; customer: (draft: OrderDraft) => Promise<unknown>; cancel: () => unknown };
export type Converse = (prompt: TurnPrompt, act: TurnActions, requestContext: RequestContext) => Promise<{ reply: string; locale: AppConfig['locale'] }>;

/**
 * What the agent remembers of a reply: its own words, and only a labelled first line of anything the application wrote
 * (drafts, summaries, confirmations). The open request reaches the agent in full every turn, so nothing is lost, and the
 * agent never learns to reproduce application templates as if they were its own words.
 */
export function remembered(plan: Pick<ReplyPlan, 'texts' | 'agentText'>) {
  const delivered = plan.texts.join('\n\n');
  const own = plan.agentText?.trim() ?? '';
  const application = (own && delivered.includes(own) ? delivered.replace(own, '') : delivered).trim();
  return [own, application ? `[Application message: ${application.split('\n').find(line => line.trim())!.trim()}]` : ''].filter(Boolean).join('\n');
}

/** The agent's answer each turn. Reply format and language rules live here, next to the fields they govern. */
const replySchema = (fallback: AppConfig['locale'], currency: AppConfig['currency']) => z.object({
  // Chosen before the reply is written, so the reply follows it.
  locale: z.enum(['it', 'en']).describe(`The language operatorWords are written in, unless the operator asked for another. Only words with no language of their own ("ok", a product name) keep the conversation's language; with no cue at all, ${fallback === 'it' ? 'Italian' : 'English'}.`),
  reply: z.string().describe(`Your own words in that language, shown above any draft: short, no greeting or recap, or empty when the draft speaks for itself. Answer product questions by listing the matches yourself, one per line, "name — code — ${currency} net" (catalogue prices are net; a tester only when asked for). Never write a draft or summary yourself.`),
});

/**
 * One agent turn per operator message: the agent reads the conversation, calls the order and customer APIs as it sees
 * fit, and replies. The application renders whatever the APIs last reported as the draft or summary under that reply.
 * `converse` replaces the model with a script, for tests and offline evaluation.
 */
export function createConversationEngine(config: AppConfig, connector: OrderConnector, storage: LibSQLStore, options: { converse?: Converse; threadTitle?: string; matching?: Parameters<typeof createOrderAgent>[4] } = {}): ConversationEngine & { traceTurn: <T>(id: number, action: () => Promise<T>) => Promise<T>; shutdown: () => Promise<void>; media: (download: Download) => MediaReader } {
  const live = options.converse ? { enabled: false, rate: 0 } : liveEvalSettings();
  const { agent, memory, scorers, matching, drafts, calls } = createOrderAgent(config, connector, storage, live, options.matching);
  const observability = new Observability({ configs: { default: { serviceName: `orderflow-${config.channel.provider}`, exporters: [new MastraStorageExporter()], spanOutputProcessors: [omitMedia] } } });
  const deliveredReply = createDeliveredReplyWorkflow(scorers, live);
  const { mediaReader, formReader } = createMediaAgents(config);
  const readOrderForm = createDocumentWorkflow(documentTemplates(config.orderForms), modelVision(formReader));
  const mastra = new Mastra({ observability, storage, agents: { orderAssistant: agent, mediaReader, formReader }, workflows: { deliveredReply, readOrderForm }, scorers: Object.fromEntries(Object.values(scorers).map(scorer => [scorer.id, scorer])) });
  /** Media reading through the registered agents and workflow, so it shows up in traces like the rest of the turn. */
  const media = (download: Download) => createMediaReader(config, connector, download, {
    documents: createVisionDocumentProvider({ read: modelReader(mediaReader), templates: workflowTemplatePages(mastra.getWorkflow('readOrderForm')) }),
    ...(config.transcription ? { transcribe: voiceTranscriber(mediaReader) } : {}),
  });
  const shared = groupMemory(config);
  // The shared thread is never deleted, so one successful check per process is enough.
  let sharedThread: Promise<void> | undefined;
  const ensureSharedThread = () => sharedThread ??= (async () => {
    if (!await memory.getThreadById({threadId:shared.thread})) await memory.createThread({threadId:shared.thread,resourceId:shared.resource,title: options.threadTitle ?? 'OrderFlow conversation'});
  })().catch(error => { sharedThread = undefined; throw error; });

  const reply = replySchema(config.locale, config.currency);
  const converse: Converse = options.converse ?? (async (prompt, _act, requestContext) => {
    await ensureSharedThread();
    const response = await agent.generate(JSON.stringify(prompt), {
      tracingContext: tracingContext(), requestContext, maxSteps: 8, providerOptions: reasoning('medium'), structuredOutput: { schema: reply },
      // Recent context only: the configured window (two stored messages per turn), with the open request supplied separately.
      memory: { ...shared, options: { readOnly: true, lastMessages: config.memory.lastMessages } },
    });
    return response.object;
  });

  /** The new revision of a request and its template, from what the order or customer API reported. */
  const render = (result: DraftResult, previous: Conversation, locale: AppConfig['locale']): { order: Conversation; text: string } => {
    const it = locale === 'it';
    const next: Conversation = { ...previous, locale, revision: previous.revision + 1, draft: result.draft, matchingDecisions: result.decisions,
      confirmedChoices: confirmedChoices(result.decisions), prepared: undefined, totals: undefined, issues: undefined };
    if (result.kind === 'customer') {
      if (result.status === 'existing') return { order: { ...next, status: 'reviewed' }, text: existingCustomer(result.client, it) };
      if (result.status === 'ready') return { order: { ...next, status: 'ready' }, text: customerPreview(result.customer, it, [], config.tax?.italy) };
      return { order: { ...next, status: 'suspended', issues: result.issues }, text: customerPreview(result.draft.newClient ?? {}, it, result.issues.map(i => i.field.replace(/^client\./, '')), config.tax?.italy) };
    }
    if (result.status === 'ready') return { order: { ...next, status: 'ready', prepared: result.order, totals: result.totals },
      text: orderPreview(result.order, result.totals, it, result.discrepancies, config.currency) };
    return { order: { ...next, status: 'suspended', issues: result.issues }, text: orderDraft(result.draft, result.issues, it, result.client, config.currency) };
  };

  const turn = async (input: TurnInput) => {
    const { request } = input;
    // Evidence for identity matching: this request's conversation so far and this message, kept as its source text.
    const evidence = appendSource(request?.sourceText, input.text);
    const requestContext = evalContext();
    const outcome = startTurn(requestContext, {
      evidence, operatorWords: input.operatorText, senderId: input.senderId,
      knownPhrases: [request?.draft.clientQuery, ...request?.draft.lines.map(line => line.query) ?? []].filter((p): p is string => !!p),
      ...(request ? { request: { kind: kindOf(request), orderId: request.orderId, revision: request.revision, confirmedChoices: request.confirmedChoices } } : {}),
      ...(input.locked ? { locked: input.locked } : {}),
    });
    const prompt: TurnPrompt = {
      speaker: { id: input.senderId, role: 'operator' }, operatorWords: input.operatorText,
      ...(input.text !== input.operatorText ? { messageWithAttachments: input.text } : {}),
      openRequest: request ? { kind: kindOf(request), status: request.status, draft: request.draft, openIssues: issuesForAgent(request.issues ?? []) } : null,
      ...(input.locked ? { otherOpenRequest: input.locked } : {}),
    };
    const act: TurnActions = { order: draft => calls.order(draft, requestContext), customer: draft => calls.customer(draft, requestContext), cancel: () => calls.cancel(requestContext) };
    const { reply, locale } = await converse(prompt, act, requestContext);
    if (outcome.cancel) return { text: reply, reply, locale, cancel: true };
    const { result } = outcome;
    if (!result) return { text: reply, reply, locale, ...(outcome.refused ? { blocked: true } : {}) };
    // A request of the other kind replaces the open one, keeping its conversation so far.
    const replaced = request && result.kind !== kindOf(request) ? request : undefined;
    const rendered = render(result, { ...(replaced || !request ? input.fresh(result.kind) : request), sourceText: evidence }, locale);
    return { text: [reply.trim(), rendered.text].filter(Boolean).join('\n\n'), reply, locale, order: rendered.order, ...(replaced ? { replaced } : {}) };
  };

  /**
   * Checks a request again with the order or customer API, with no model involved: after the operator picks a
   * candidate with a button, or after a configuration change, so the draft is kept and re-validated.
   */
  const revise = async (previous: Conversation, choice?: Choice) => {
    const draft = structuredClone(previous.draft);
    const line = choice && lineIndex(choice.field);
    if (line !== undefined && draft.lines[line]) draft.lines[line]!.productId = choice!.id;
    if (choice?.field === 'client') { draft.clientId = choice.id; delete draft.newClient; }
    const context = { orderId: previous.orderId, revision: previous.revision + 1, operatorText: previous.sourceText ?? '', confirmedChoices: previous.confirmedChoices, choice };
    const result = kindOf(previous) === 'customer' ? await drafts.customer(draft, context) : await drafts.order(draft, context);
    return render(result, previous, previous.locale ?? config.locale);
  };

  const record: NonNullable<ConversationEngine['record']> = async (id, plan) => {
    // Stable message IDs make transport replay safe. Include application-rendered
    // summaries and save results, which agent.generate does not produce itself.
    await ensureSharedThread();
    let history: MastraDBMessage[] = [];
    let canEvaluate = live.enabled;
    if (live.enabled) {
      try {
        let previous = await memory.recall({ threadId: shared.thread, perPage: 1, filter: { metadata: { channelMessageId: id } } });
        if (!previous.messages.length) previous = await memory.recall({ threadId: shared.thread, perPage: 1, filter: { metadata: { telegramUpdateId: id } } });
        canEvaluate = previous.messages.length === 0;
        if (canEvaluate) history = (await memory.recall({ threadId: shared.thread, perPage: config.memory.lastMessages, orderBy: { field: 'createdAt', direction: 'DESC' } })).messages; // The newest page, already in conversation order.
      } catch {
        canEvaluate = false;
        console.warn('Live evaluation history unavailable; skipping scoring for this delivered reply.');
      }
    }
    const values = [
      {role:'user' as const,text:JSON.stringify({speaker:{id:plan.senderId,role:'operator'},message:plan.incomingText})},
      {role:'assistant' as const,text:remembered(plan)}
    ];
    // The reply is stored a millisecond after the message it answers, so history always reads in conversation order.
    const at = Date.now();
    const messages: MastraDBMessage[] = values.map((value,index) => ({
      id:`${shared.thread}:update:${id}:${index}`,threadId:shared.thread,resourceId:shared.resource,createdAt:new Date(at + index),role:value.role,
      content:{format:2 as const,parts:[{type:'text' as const,text:value.text}], metadata: index === 1 ? { channelMessageId: id, telegramUpdateId: id, applicationEvidence: {
        source: 'channel-controller', delivery: 'delivered', updateId: id,
        orderId: plan.order?.orderId, revision: plan.order?.revision,
        kind: plan.order?.kind ?? (plan.order ? 'order' : undefined), status: plan.order?.status,
        draft: plan.order?.draft, prepared: plan.order?.prepared, totals: plan.order?.totals,
        savedOrder: plan.order?.savedOrder ? { id: plan.order.savedOrder.id, number: plan.order.savedOrder.number } : undefined,
        customerSaveSucceeded: plan.order?.kind === 'customer' && plan.order.status === 'reviewed',
      } } : undefined }
    }));
    await memory.saveMessages({messages});
    if (canEvaluate && plan.incomingText) {
      try {
        const run = await mastra.getWorkflow('deliveredReply').createRun({ runId: `channel-eval-${id}` });
        await run.start({ tracingContext: tracingContext(), inputData: {
          input: { inputMessages: [messages[0]!], rememberedMessages: history, systemMessages: [], taggedSystemMessages: {} },
          output: [messages[1]!],
          // An observed application outcome, not a reconstructed model/tool trace.
          trajectory: { steps: [{ stepType: 'workflow_step', name: 'delivered-reply', status: 'success', output: messages[1]!.content.metadata?.applicationEvidence as Record<string, unknown> }], rawOutput: [messages[1]!] },
        }, requestContext: evalContext() });
      } catch { console.warn('Live evaluation dispatch failed; the delivered reply and business state are unchanged.'); }
    }
  };
  const shutdown = async () => {
    // Mastra 1.71 closes storage before shutting down exporters. Drain workers and
    // flush while storage is still open, so the final turns/scores are retained.
    await mastra.stopWorkers({ drainTimeout: 30000 });
    await observability.flush();
    await mastra.shutdown({ drainTimeout: 30000 });
  };
  return { turn, revise, ...(matching.mode === 'on' ? { matchingPolicy: matching.policy } : {}), record, media, traceTurn: <T>(id: number, action: () => Promise<T>) => traceChannelTurn(observability.getDefaultInstance(), id, action), shutdown };
}
