import { customerCreationSkill } from './skills/customer-creation.js';
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

export const sharedKnowledgeSchema = z.object({
  aliases: z.array(z.object({
    phrase: z.string(), productId: z.number().int().positive(),
    sourceMessage: z.string(), confirmedBy: z.string(),
  }).strict()).default([]),
}).strict();

export function memoryScope(config: AppConfig, orderId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(orderId)) throw new Error('Invalid order reference');
  return { resource: config.deploymentId, thread: `${config.deploymentId}:order:${orderId}` };
}

export function createOrderAgent(config: AppConfig, connector: OrderConnector, storage: LibSQLStore, live: LiveEvalSettings = { enabled: false, rate: 0 }) {
  const memory = new Memory({ storage, options: {
    lastMessages: config.memory.lastMessages,
    semanticRecall: false,
    workingMemory: { enabled: true, scope: 'resource', schema: sharedKnowledgeSchema, agentManaged: false },
  } });
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
    execute: async ({ query }) => searchCatalogue(query, await searchable()),
  });
  const searchClients = createTool({
    id: 'search-clients', description: 'Find existing businesses by name or VAT number. Do not create a duplicate when a record exists.',
    inputSchema: z.object({ query: z.string().min(1) }),
    outputSchema: z.array(z.object({ id: z.number(), name: z.string(), country: z.string(), vatNumber: z.string().optional() })),
    execute: async ({ query }) => {
      const words = normalize(query).split(/\s+/).filter(Boolean);
      return (await connector.listClients()).filter(c => c.id && words.length && words.every(w => normalize(`${c.name} ${c.vatNumber ?? ''}`).includes(w)))
        .map(c => ({ id: c.id!, name: c.name, country: c.country, vatNumber: c.vatNumber }));
    },
  });
  const scorers = createManualScorers([
    { id: 'searchProducts', description: searchProducts.description },
    { id: 'searchClients', description: searchClients.description },
    { id: 'search_skills', description: 'Discover skills by keyword, including customer-creation.' },
    { id: 'load_skill', description: 'Load customer-creation guidance for identity and details; not a write operation.' },
  ], process.env.EVAL_JUDGE_MODEL);
  const agent = new Agent({
    // Keep the persisted agent ID stable across the OrderFlow rebrand.
    id: 'order-assistant', name: 'OrderFlow', model: config.model,
    instructions: buildSystemPrompt(config),
    skills: [customerCreationSkill(config)],
    memory, tools: { searchProducts, searchClients },
    scorers: liveAgentScorers(scorers, live),
  });
  const extract: Extractor = async (text, orderId) => {
    const response = await agent.generate(text, {
      memory: memoryScope(config, orderId), structuredOutput: { schema: extractionSchema }, maxSteps: 8,
      requestContext: evalContext('extraction'),
    });
    return parseExtraction(response.object);
  };
  return { agent, memory, extract, scorers };
}
