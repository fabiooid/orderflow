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
    expect(tools.searchClients?.description).toContain('always call this before prepare-order');
    expect(tools.searchClients?.description).toContain('call this again');
    expect(tools.prepareOrder?.description).toContain('always call search-clients first');
    expect(tools.prepareOrder?.description).toContain('not a substitute');
    expect(Object.values(tools).every(tool => !/creates?|saves?|writes?/i.test(tool.id))).toBe(true);
    expect(await agent.listSkills()).toEqual([]);
  } finally { await storage.close(); }
});

it('keeps business rules in the prompt and field rules in the API schema, with no slash commands', () => {
  const prompt = systemPrompt(config().invoicing.label);
  expect(prompt).toContain('Never create invoices or proformas');
  expect(prompt).toContain('Only the operator saves');
  expect(prompt).toContain('out of scope');
  expect(prompt).toContain('# Start an order');
  expect(prompt).toContain('always call search-clients');
  expect(prompt).toContain("Do not let prepare-order's internal match choose the customer");
  expect(prompt).toContain('call search-clients again with the refined words');
  expect(prompt).toContain('Naming a customer is not a request to copy products');
  expect(prompt).not.toMatch(/\/(?:ordine|cliente|annulla|confermaordine|confermacliente)\b/);
  const fields = orderDraftInput.shape;
  expect(fields.newClient.description).toContain('attached email');
  expect(fields.notes.description).toContain('operator sees it in the draft');
  expect(fields.delivery.description).toContain('never a delivery address');
  expect(fields.clientQuery.description).toContain('search-clients');
  expect(fields.clientId.description).toContain('do not keep the old id');
  expect(fields.lines.description).toContain('A new request starts with no lines');
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

it('hands the agent the catalogue when no product contains the words, so it can judge by meaning', async () => {
  const storage = new LibSQLStore({ id: 'agent-search', url: ':memory:' });
  try {
    const tools = await createOrderAgent(config(), new DemoConnector(), storage).agent.listTools();
    const search = (query: string) => tools.searchProducts!.execute!({ query }, {} as never) as Promise<{ found: string; products: { name: string }[] }>;
    expect(await search('candle')).toMatchObject({ found: 'words', products: [{ name: 'Linen candle 200 g' }] });
    const soaps = await search('saponi');
    expect(soaps.found).toBe('catalogue');
    expect(soaps.products.map(p => p.name)).toContain('Pebble hand wash 250 ml');
    expect((await search('')).found).toBe('catalogue');
  } finally { await storage.close(); }
});

it('finds a client by hint words in notes and returns those notes so the agent can tell siblings apart', async () => {
  const storage = new LibSQLStore({ id: 'client-notes-search', url: ':memory:' });
  try {
    const connector = new DemoConnector();
    connector.clients.push(
      { id: '203', name: 'Fable Rooms Srl', country: 'IT', street: 'Harbour 1', city: 'Genova', postalCode: '16100', vatNumber: 'DEMO-FABLE-ROOMS', notes: 'Fable Harbor hotel' },
      { id: '204', name: 'Fable Shop Srl', country: 'IT', street: 'Harbour 2', city: 'Genova', postalCode: '16100', vatNumber: 'DEMO-FABLE-SHOP', notes: 'Fable Harbor shop' },
    );
    const tools = await createOrderAgent(config(), connector, storage).agent.listTools();
    const search = (query: string) => tools.searchClients!.execute!({ query }, {} as never) as Promise<{ id: string; notes?: string }[]>;
    expect(await search('Fable Harbor hotel')).toEqual([expect.objectContaining({ id: '203', notes: 'Fable Harbor hotel' })]);
    expect(await search('Fable Harbor shop')).toEqual([expect.objectContaining({ id: '204', notes: 'Fable Harbor shop' })]);
    expect((await search('Fable Harbor')).map(c => c.id).sort()).toEqual(['203', '204']);
  } finally { await storage.close(); }
});
