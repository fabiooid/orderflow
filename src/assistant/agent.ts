import { customerCreationSkill } from './skills/customer-creation.js';
import { tracingContext } from './execution-trace.js';
import { aliasMemory, sharedKnowledgeSchema } from './aliases.js';
export { sharedKnowledgeSchema } from './aliases.js';
import { customerOrderHistoryTool } from './customer-order-history.js';
import { buildSystemPrompt } from './system-prompt.js';
import { extractionSchema, parseExtraction } from './extraction-schema.js';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import type { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import type { OrderConnector } from '../connector/contract.js';
import { productSchema, type Product } from '../domain/types.js';
import { normalize, searchCatalogue } from '../domain/matching.js';
import type { Extractor } from './workflow.js';
import { createManualScorers } from './manual-scorers.js';
import { evalContext, liveAgentScorers, type LiveEvalSettings } from './live-evals.js';

export function memoryScope(config: AppConfig, orderId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(orderId)) throw new Error('Invalid order reference');
  return { resource: `${config.deploymentId}:telegram:${config.telegram.groupId}`, thread: `${config.deploymentId}:order:${orderId}` };
}

export function createOrderAgent(config: AppConfig, connector: OrderConnector, storage: LibSQLStore, live: LiveEvalSettings = { enabled: false, rate: 0 }) {
  const memory = new Memory({ storage, options: {
    lastMessages: config.memory.lastMessages,
    semanticRecall: false,
    workingMemory: { enabled: true, scope: 'resource', schema: sharedKnowledgeSchema, agentManaged: false },
  } });
  const knowledge = aliasMemory(memory, `${config.deploymentId}:telegram:${config.telegram.groupId}`, connector);
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
    id: 'search-products', description: 'Search the catalogue with any words (scent, type, size, code). Returns related products, best first. Search again with fewer or different words when nothing fits.',
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
  const scorers = createManualScorers([
    { id: 'searchProducts', description: searchProducts.description },
    { id: 'searchClients', description: searchClients.description },
    { id: 'getCustomerOrderHistory', description: getCustomerOrderHistory.description },
    { id: 'rememberAlias', description: knowledge.rememberAlias.description },
    { id: 'search_skills', description: 'Discover skills by keyword, including customer-creation.' },
    { id: 'load_skill', description: 'Load customer-creation guidance for identity and details; not a write operation.' },
  ], process.env.EVAL_JUDGE_MODEL);
  const agent = new Agent({
    // Keep the persisted agent ID stable across the OrderFlow rebrand.
    id: 'order-assistant', name: 'OrderFlow', model: config.model,
    instructions: buildSystemPrompt(config),
    skills: [customerCreationSkill(config)],
    memory, tools: { searchProducts, searchClients, getCustomerOrderHistory, rememberAlias: knowledge.rememberAlias },
    scorers: liveAgentScorers(scorers, live),
  });
  const extract: Extractor = async (text, orderId) => {
    const scope = memoryScope(config, orderId);
    // Preserve ownership and history of order threads created before shared alias learning.
    const existing = await memory.getThreadById({ threadId: scope.thread });
    if (existing?.resourceId) scope.resource = existing.resourceId;
    const response = await agent.generate(text, {
      tracingContext: tracingContext(),
      memory: scope, structuredOutput: { schema: extractionSchema }, maxSteps: 8,
      requestContext: evalContext('extraction'),
    });
    return parseExtraction(response.object);
  };
  return { agent, memory, extract, scorers };
}
