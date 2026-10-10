import { expect, it } from 'vitest';
import { z } from 'zod';
import { LibSQLStore } from '@mastra/libsql';
import { createOrderAgent, sharedKnowledgeSchema } from '../src/assistant/agent.js';
import { replySchema } from '../src/channel/engine.js';
import { orderDraftInput } from '../src/assistant/draft-schema.js';
import { systemPrompt } from '../src/assistant/system-prompt.js';
import { DemoConnector } from '../src/connector/demo.js';
import { config } from './helpers.js';

it('gives the agent the order and customer APIs and lookups, and no way to save', async () => {
  const storage = new LibSQLStore({ id: 'agent-tools', url: ':memory:' });
  try {
    const { agent } = createOrderAgent(config(), new DemoConnector(), storage);
    const tools = await agent.listTools();
    expect(Object.keys(tools).sort()).toEqual(['cancelRequest', 'getCustomerOrderHistory', 'prepareCustomer', 'prepareOrder', 'rememberAlias', 'searchClients', 'searchProducts']);
    expect(Object.values(tools).every(tool => !/creates?|saves?|writes?/i.test(tool.id))).toBe(true);
    expect(await agent.listSkills()).toEqual([]);
  } finally { await storage.close(); }
});

it('keeps business rules in the prompt and field rules in the API schema, with no slash commands', () => {
  const prompt = systemPrompt(config().invoicing.label);
  expect(prompt).toContain('Never create invoices or proformas');
  expect(prompt).toContain('Only the operator saves');
  expect(prompt).toContain('out of scope');
  expect(prompt).not.toMatch(/\/(?:ordine|cliente|annulla|confermaordine|confermacliente)\b/);
  const fields = orderDraftInput.shape;
  expect(fields.newClient.description).toContain('attached email');
  expect(fields.notes.description).toContain('operator sees it in the draft');
  expect(fields.delivery.description).toContain('never a delivery address');
});

/**
 * Every schema the model receives becomes JSON Schema at call time. A transform or other unrepresentable step passes
 * the scripted tests but fails every live turn, so each one is converted here.
 */
it('sends the model only schemas that convert to JSON Schema', async () => {
  const storage = new LibSQLStore({ id: 'agent-schemas', url: ':memory:' });
  try {
    const c = config();
    const tools = await createOrderAgent(c, new DemoConnector(), storage).agent.listTools();
    const schemas: [string, unknown][] = [
      ...Object.entries(tools).map(([id, tool]): [string, unknown] => [id, tool.inputSchema]),
      ['working memory', sharedKnowledgeSchema],
      ['reply', replySchema(c.locale, c.currency)],
    ];
    for (const [name, schema] of schemas) expect(() => z.toJSONSchema(schema as z.ZodType), name).not.toThrow();
  } finally { await storage.close(); }
});
