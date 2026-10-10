import { createIdentityResolver } from '../matching/resolver.js';
import { loadMatchingConfig } from '../matching/config.js';
import { aliasMemory, sharedKnowledgeSchema } from './aliases.js';
export { sharedKnowledgeSchema } from './aliases.js';
import { customerOrderHistoryTool } from './customer-order-history.js';
import { systemPrompt } from './system-prompt.js';
import { customerDraftInput, orderDraftInput, parseCustomer, parseDraft } from './draft-schema.js';
import { createDraftApi, forAgent, type DraftResult } from './drafts.js';
import { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import type { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import type { OrderConnector } from '../connector/contract.js';
import { productSchema, type OrderDraft, type Product } from '../domain/types.js';
import { normalize, searchCatalogue } from '../domain/matching.js';
import { outcomeOf, turnOf, type TurnRequest } from './turn-context.js';
import { createManualScorers } from './manual-scorers.js';
import { liveAgentScorers, type LiveEvalSettings } from './live-evals.js';

/** The shared Mastra memory of one Telegram group: its conversation thread and the resource holding learned aliases. */
export function groupMemory(config: AppConfig) {
  const resource = `${config.deploymentId}:${config.channel.provider}:${config.channel.groupId}`;
  return { resource, thread: `${resource}:chat` };
}

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
  const searchProducts = createTool({
    id: 'search-products', description: 'Search the catalogue with any words (scent, type, size, code). Returns related products, best first. When nothing fits, search again with fewer, different or translated words: catalogue names can be in Italian or English.',
    inputSchema: z.object({ query: z.string().min(1) }), outputSchema: z.array(productSchema),
    execute: async ({ query }) => {
      const [products, data] = await Promise.all([searchable(), knowledge.read()]);
      const ids = new Set(data.aliases.filter(a => normalize(a.phrase) === normalize(query)).map(a => a.productId));
      return [...new Map([...products.filter(p => ids.has(p.id)), ...searchCatalogue(query, products)].map(p => [p.id, p])).values()];
    },
  });
  const searchClients = createTool({
    id: 'search-clients', description: 'Find existing businesses by name or VAT number. Do not create a duplicate when a record exists.',
    inputSchema: z.object({ query: z.string().min(1) }),
    outputSchema: z.array(z.object({ id: z.number(), name: z.string(), country: z.string(), vatNumber: z.string().optional() })),
    execute: async ({ query }) => {
      const words = normalize(query).split(/\s+/).filter(Boolean);
      const data = await knowledge.read();
      const ids = new Set(data.clientAliases.filter(a => normalize(a.phrase) === normalize(query)).map(a => a.clientId));
      return (await connector.listClients()).filter(c => c.id && (ids.has(c.id) || words.length && words.every(w => normalize(`${c.name} ${c.vatNumber ?? ''}`).includes(w))))
        .map(c => ({ id: c.id!, name: c.name, country: c.country, vatNumber: c.vatNumber }));
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
    async (draft: OrderDraft, requestContext?: RequestContext) => {
      const turn = turnOf(requestContext), outcome = outcomeOf(requestContext);
      if (!turn?.request && turn?.locked) {
        outcome.refused = true;
        return { status: 'blocked' as const, note: `Another request is open: ${turn.locked}. The operator can finish it first.` };
      }
      const own = turn?.request?.kind === kind ? turn.request : undefined;
      outcome.result = await run(draft, { orderId: own?.orderId ?? 'new', revision: (own?.revision ?? 0) + 1, operatorText: turn?.evidence ?? '', confirmedChoices: own?.confirmedChoices });
      return forAgent(outcome.result);
    };
  const draftOutput = z.object({ status: z.enum(['ready', 'needs', 'existing', 'blocked', 'invalid']), issues: z.array(z.object({ field: z.string(), problem: z.string(), candidates: z.array(z.string()).optional() })).optional(), note: z.string() });
  /** A draft tool: parse the agent's draft against the schema, then run the API on it. */
  const draftTool = <S extends z.ZodType>(id: string, description: string, inputSchema: S, parse: (input: unknown) => OrderDraft, api: ReturnType<typeof prepare>) => createTool({
    id, description, inputSchema, outputSchema: draftOutput,
    execute: async (input, context) => {
      let draft: OrderDraft;
      try { draft = parse(input); } catch (error) {
        return { status: 'invalid' as const, note: `The draft does not fit the schema: ${error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : 'unreadable'}. Fix it and call again.` };
      }
      return api(draft, context?.requestContext);
    },
  });
  const orderApi = prepare('order', drafts.order), customerApi = prepare('customer', drafts.customer);
  const prepareOrder = draftTool('prepare-order', "The order API: create or edit the order. Send the complete order as it should be after this turn, starting from the open order's draft. The application checks customer, products, prices, VAT and delivery against Fatture in Cloud, shows the draft to the operator and reports what is still needed. It never saves.",
    orderDraftInput, parseDraft, orderApi);
  const prepareCustomer = draftTool('prepare-customer', "The customer API: create a new customer in Fatture in Cloud, or correct the one being drafted. Send every detail known so far. The application checks for an existing customer, shows the draft and reports what is still needed. It never saves. For an order's customer use prepare-order instead.",
    customerDraftInput, parseCustomer, customerApi);
  const cancel = (requestContext?: RequestContext) => {
    const turn = turnOf(requestContext);
    if (turn?.request) { outcomeOf(requestContext).cancel = true; return { status: 'cancelled' as const }; }
    return turn?.locked ? { status: 'locked' as const, note: `${turn.locked}: it cannot be cancelled here.` } : { status: 'nothing-open' as const };
  };
  const cancelRequest = createTool({
    id: 'cancel-request',
    description: 'Cancel the open unsaved order or customer request, only when the operator asks to drop it. Nothing saved is affected.',
    inputSchema: z.object({}), outputSchema: z.object({ status: z.enum(['cancelled', 'locked', 'nothing-open']), note: z.string().optional() }),
    execute: async (_input, context) => cancel(context?.requestContext),
  });
  const tools = { prepareOrder, prepareCustomer, cancelRequest, searchProducts, searchClients, getCustomerOrderHistory, rememberAlias: knowledge.rememberAlias };
  const scorers = createManualScorers(Object.entries(tools).map(([id, tool]) => ({ id, description: tool.description })), process.env.EVAL_JUDGE_MODEL);
  const agent = new Agent({
    // Keep the persisted agent ID stable across the OrderFlow rebrand.
    id: 'order-assistant', name: 'OrderFlow', model: config.model,
    instructions: systemPrompt,
    memory, tools,
    scorers: liveAgentScorers(scorers, live),
  });
  /** What the draft tools do, callable directly by a scripted stand-in for the model in tests and offline evals. */
  const calls = { order: orderApi, customer: customerApi, cancel };
  return { agent, memory, scorers, matching, drafts, calls };
}
