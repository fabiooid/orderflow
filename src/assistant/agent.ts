import { createIdentityResolver } from '../matching/resolver.js';
import { loadMatchingConfig } from '../matching/config.js';
import { aliasMemory, sharedKnowledgeSchema } from './aliases.js';
export { sharedKnowledgeSchema } from './aliases.js';
import { customerOrderHistoryTool } from './customer-order-history.js';
import { systemPrompt } from './system-prompt.js';
import { customerDraftInput, draftOutput, orderDraftInput, parseCustomer, parseDraft, parseLinePatches } from './draft-schema.js';
import { createDraftApi, forAgent, type DraftResult } from './drafts.js';
import { mergeOrderDraft } from './merge.js';
import { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import type { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import type { OrderConnector } from '../connector/contract.js';
import { productSchema, type OrderDraft, type Product } from '../domain/types.js';
import { matchProducts, normalize, relatedProducts, searchClients as findClients } from '../domain/matching.js';
import { outcomeOf, recordSearch, turnOf, type TurnRequest } from './turn-context.js';
import { createManualScorers } from './manual-scorers.js';
import { liveAgentScorers, type LiveEvalSettings } from './live-evals.js';

/** The shared Mastra memory of one Telegram group: its conversation thread and the resource holding learned aliases. */
export function groupMemory(config: AppConfig) {
  const resource = `${config.deploymentId}:${config.channel.provider}:${config.channel.groupId}`;
  return { resource, thread: `${resource}:chat` };
}

/** Products the agent may read at once to judge by meaning; a larger catalogue needs words that appear in it. */
const CATALOGUE_LIST_LIMIT = 300;

export function createOrderAgent(config: AppConfig, connector: OrderConnector, storage: LibSQLStore, live: LiveEvalSettings = { enabled: false, rate: 0 }, matchingOptions: Parameters<typeof createIdentityResolver>[2] = {}) {
  const memory = new Memory({ storage, options: {
    lastMessages: config.memory.lastMessages,
    semanticRecall: false,
    workingMemory: { enabled: true, scope: 'resource', schema: sharedKnowledgeSchema, agentManaged: false },
  } });
  const matchingConfig = matchingOptions.config ?? loadMatchingConfig();
  const knowledge = aliasMemory(memory, groupMemory(config).resource, connector, matchingConfig.mode === 'on');
  const matching = createIdentityResolver(config, connector, { ...matchingOptions, config: matchingConfig, aliases: knowledge.read });
  // Search only: results may be up to two minutes old. Order preparation always reads fresh prices.
  let catalogue: { at: number; products: Promise<Product[]> } | undefined;
  const searchable = () => {
    if (!catalogue || Date.now() - catalogue.at > 2 * 60_000) {
      const products = connector.listProducts().catch(error => { catalogue = undefined; throw error; });
      catalogue = { at: Date.now(), products };
    }
    return catalogue.products;
  };
  /**
   * Word search finds products by their literal words; meaning is the agent's job. When some words hit and others
   * miss, the agent gets those related products so it can say the combination is missing. When nothing shares the
   * words, or nothing is asked for, it gets the catalogue itself (up to a size that fits a model call) to judge.
   */
  const searchProducts = createTool({
    id: 'search-products',
    description: 'Find products in the catalogue. With words (scent, type, size, code) it returns products that contain every word (found=words). If no product has every word, it returns products that match each word separately (found=related): say that combination is not in the catalogue, list the real products for each requested detail, and do not present a related product as the requested item. With no words, or when no product shares them, it returns the catalogue so you can judge by meaning which products fit, in any language ("saponi" can be a hand wash). found=catalogue is not identity evidence. A "what exists" question lists the catalogue; for an order line, name only the products that fit that meaning and call prepare-order — do not paste the whole catalogue into the reply. This does not open a draft. Answer from what it returns; never invent products.',
    inputSchema: z.object({ query: z.string().describe('Words to look for; empty to see the catalogue.') }),
    outputSchema: z.object({ found: z.enum(['words', 'related', 'catalogue', 'catalogue-too-large']), products: z.array(productSchema) }),
    execute: async ({ query }, context) => {
      const [products, data] = await Promise.all([searchable(), knowledge.read()]);
      const ids = new Set(data.aliases.filter(a => normalize(a.phrase) === normalize(query)).map(a => a.productId));
      const exact = [...new Map([...products.filter(p => ids.has(p.id)), ...matchProducts(query, products)].map(p => [p.id, p])).values()];
      const result = exact.length ? { found: 'words' as const, products: exact }
        : relatedProducts(query, products).length ? { found: 'related' as const, products: relatedProducts(query, products) }
        : products.length <= CATALOGUE_LIST_LIMIT ? { found: 'catalogue' as const, products } : { found: 'catalogue-too-large' as const, products: [] as Product[] };
      if (result.found === 'words' || result.found === 'related') {
        recordSearch(context?.requestContext, { kind: 'product', query, ids: result.products.slice(0, 30).map(p => p.id) });
      }
      return result;
    },
  });
  const searchClients = createTool({
    id: 'search-clients',
    description: 'Find existing businesses by legal name, VAT, city, street, everyday name in notes, or contact person. Read `clients`, not `found` alone. One close account is still a question unless the operator typed that exact name or VAT. Results feed prepare-order as candidates, not as a lock. Search does not change the draft: still call prepare-order with that wording as clientQuery. Search only a name or VAT given in this request. Do not search a customer from earlier messages when this request did not name one. Letterhead is not a customer.',
    inputSchema: z.object({ query: z.string().min(1).describe('The name or VAT number the operator gave, including hint words such as hotel, shop, or a city. Call again with a refined query when they clarify.') }),
    outputSchema: z.object({
      found: z.number().int().nonnegative().describe('How many client records are in `clients`. This count is not a client id and not a substitute for the list.'),
      clients: z.array(z.object({ id: z.string().min(1), name: z.string(), country: z.string(), city: z.string().optional(), street: z.string().optional(), vatNumber: z.string().optional(), notes: z.string().optional(), contactPerson: z.string().optional() })),
    }),
    execute: async ({ query }, context) => {
      const data = await knowledge.read();
      const ids = new Set(data.clientAliases.filter(a => normalize(a.phrase) === normalize(query)).map(a => a.clientId));
      const listed = await connector.listClients();
      const found = [...listed.filter(c => c.id && ids.has(c.id)), ...findClients(query, listed)];
      const clients = [...new Map(found.filter(c => c.id).map(c => [c.id!, c])).values()]
        .map(c => ({ id: c.id!, name: c.name, country: c.country, ...(c.city ? { city: c.city } : {}), ...(c.street?.trim() ? { street: c.street } : {}), vatNumber: c.vatNumber, ...(c.notes?.trim() ? { notes: c.notes } : {}), ...(c.contactPerson?.trim() ? { contactPerson: c.contactPerson } : {}) }));
      recordSearch(context?.requestContext, { kind: 'client', query, ids: clients.slice(0, 30).map(c => c.id) });
      return { found: clients.length, clients };
    },
  });
  const getCustomerOrderHistory = customerOrderHistoryTool(connector);
  const drafts = createDraftApi(config, connector, matching);
  /**
   * The draft tools work on the open request. Using the other kind's tool replaces it (nothing is saved, and the agent
   * decides when that is what the operator wants). A request this turn cannot change, such as a save awaiting a check,
   * blocks new work, so nothing is silently left behind.
   */
  const prepare = (kind: TurnRequest['kind'], run: (draft: OrderDraft, context: Parameters<typeof drafts.order>[1]) => Promise<DraftResult>) =>
    async (draft: OrderDraft, requestContext?: RequestContext, linePatches?: ReturnType<typeof parseLinePatches>) => {
      const turn = turnOf(requestContext), outcome = outcomeOf(requestContext);
      if (!turn?.request && turn?.locked) {
        outcome.refused = true;
        return { status: 'blocked' as const, note: `Another request is open: ${turn.locked}. The operator can finish it first.` };
      }
      if (kind === 'order') {
        draft = mergeOrderDraft({
          base: turn?.request?.kind === 'order' ? turn.request.draft : undefined,
          incoming: draft,
          incomingLines: linePatches,
          attachmentLines: turn?.attachmentLines,
          operatorWords: turn?.operatorWords ?? '',
          turnWords: turn?.turnWords,
          attachmentText: turn?.attachmentText,
          isNewRequest: turn?.request?.kind !== 'order',
        });
      }
      if (kind === 'order' && !draft.clientId && !draft.clientQuery.trim() && !draft.newClient && !draft.lines.length) {
        return { status: 'needs' as const, issues: [{ field: 'client', problem: 'Name a customer or add product lines.' }], note: 'Nothing was shown. An empty draft is not opened.' };
      }
      if (kind === 'order' && draft.clientId && draft.clientId !== turn?.request?.draft.clientId) {
        draft = { ...draft };
        delete draft.clientId;
      }
      const own = turn?.request?.kind === kind ? turn.request : undefined;
      const searchEvidence = [...(own?.searchEvidence ?? []), ...(turn?.searchEvidence ?? [])];
      outcome.result = await run(draft, {
        orderId: own?.orderId ?? 'new', revision: (own?.revision ?? 0) + 1,
        operatorText: turn?.evidence ?? '',
        operatorWords: turn?.operatorWords ?? own?.operatorWords,
        attachmentText: turn?.attachmentText ?? own?.attachmentText,
        turnWords: turn?.turnWords,
        confirmedChoices: own?.confirmedChoices,
        pendingQuestion: own?.pendingQuestion,
        searchEvidence,
      });
      return forAgent(outcome.result, (own?.revision ?? 0) + 1);
    };
  const draftTool = <S extends z.ZodType>(id: string, description: string, inputSchema: S, parse: (input: unknown) => OrderDraft, api: (draft: OrderDraft, ctx?: RequestContext, patches?: ReturnType<typeof parseLinePatches>) => Promise<z.infer<typeof draftOutput>>, withPatches = false) => createTool({
    id, description, inputSchema, outputSchema: draftOutput,
    execute: async (input, context) => {
      let draft: OrderDraft;
      try { draft = parse(input); } catch (error) {
        return { status: 'invalid' as const, note: `The draft does not fit the schema: ${error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : 'unreadable'}. Fix it and call again.` };
      }
      return api(draft, context?.requestContext, withPatches ? parseLinePatches(input) : undefined);
    },
  });
  const orderApi = prepare('order', drafts.order), customerApi = prepare('customer', drafts.customer);
  const books = config.invoicing.label;
  const prepareOrder = draftTool('prepare-order', `The order API: merge this turn's changes into the open draft. Search does not open or change a draft: call this the same turn they ask to create or add to an order, including after a catalogue answer. Call this the same turn they give a clear draft edit (a note, a quantity, shipping). Do not wait for them to confirm that instruction. Empty lines keep rows already on this request (including attachment facts). Empty clientQuery when this request did not name a customer; a customer already on this open request is kept. Tester marks are their own line (tester true, printed sale code kept). productId and clientId are proposals; the application accepts supported unique SKUs/testers and exact catalogue or customer names typed this request, and otherwise keeps candidates. Do not invent catalogue codes. Do not resend a cancelled order. Do not claim ready while the result status is needs. Never saves.`,
    orderDraftInput, parseDraft, orderApi, true);
  const prepareCustomer = draftTool('prepare-customer', `The customer API: create a new customer in ${books}, or correct the one being drafted. The application never saves. For an order's customer use prepare-order instead. Missing email or VAT does not block starting an order: when they ask to create an order, call prepare-order carrying newClient.`,
    customerDraftInput, parseCustomer, customerApi);
  const cancel = (requestContext?: RequestContext) => {
    const turn = turnOf(requestContext);
    if (turn?.request) { outcomeOf(requestContext).cancel = true; return { status: 'cancelled' as const }; }
    return turn?.locked ? { status: 'locked' as const, note: `${turn.locked}: it cannot be cancelled here.` } : { status: 'nothing-open' as const };
  };
  const cancelRequest = createTool({
    id: 'cancel-request',
    description: 'Cancel the open unsaved order or customer request, only when the operator asks to drop it ("annulla", "lascia stare", "non serve più", cancel, never mind). Call this the same turn. Nothing saved is affected.',
    inputSchema: z.object({}), outputSchema: z.object({ status: z.enum(['cancelled', 'locked', 'nothing-open']), note: z.string().optional() }),
    execute: async (_input, context) => cancel(context?.requestContext),
  });
  const tools = { prepareOrder, prepareCustomer, cancelRequest, searchProducts, searchClients, getCustomerOrderHistory, rememberAlias: knowledge.rememberAlias };
  const scorers = createManualScorers(Object.entries(tools).map(([id, tool]) => ({ id, description: tool.description })), process.env.EVAL_JUDGE_MODEL);
  const agent = new Agent({
    // Keep the persisted agent ID stable across the OrderFlow rebrand.
    id: 'order-assistant', name: 'OrderFlow', model: config.model,
    instructions: systemPrompt(books),
    memory, tools,
    scorers: liveAgentScorers(scorers, live),
  });
  /** What the draft tools do, callable directly by a scripted stand-in for the model in tests and offline evals. */
  const calls = { order: orderApi, customer: customerApi, cancel };
  return { agent, memory, scorers, matching, drafts, calls };
}
