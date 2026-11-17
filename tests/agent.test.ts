import { expect, it } from 'vitest';
import { z } from 'zod';
import { LibSQLStore } from '@mastra/libsql';
import { createOrderAgent, sharedKnowledgeSchema } from '../src/assistant/agent.js';
import { replySchema } from '../src/channel/engine.js';
import { orderDraftInput } from '../src/assistant/draft-schema.js';
import { systemPrompt } from '../src/assistant/system-prompt.js';
import { DemoConnector } from '../src/connector/demo.js';
import { config, harborSiblings, pharmacyTypeAccounts, sampleNameAccounts, willowmereStayAccounts } from './helpers.js';

it('gives the agent the order and customer APIs and lookups, and no way to save', async () => {
  const storage = new LibSQLStore({ id: 'agent-tools', url: ':memory:' });
  try {
    const { agent } = createOrderAgent(config(), new DemoConnector(), storage);
    const tools = await agent.listTools();
    expect(Object.keys(tools).sort()).toEqual(['cancelRequest', 'getCustomerOrderHistory', 'prepareCustomer', 'prepareOrder', 'rememberAlias', 'searchClients', 'searchProducts']);
    expect(tools.searchClients?.description).toContain('always call this before prepare-order');
    expect(tools.searchClients?.description).toContain('call this again');
    expect(tools.searchClients?.description).toContain('everyday name');
    expect(tools.searchClients?.description).toContain('closest related accounts');
    expect(tools.searchClients?.description).toContain('short customer name');
    expect(tools.searchClients?.description).toContain('not a request to save');
    expect(tools.prepareOrder?.description).toContain('always call search-clients first');
    expect(tools.prepareOrder?.description).toContain('not a substitute');
    expect(tools.prepareOrder?.description).toContain('exact name or VAT');
    expect(tools.searchClients?.description).toContain('One close or related account is still a question');
    expect(tools.prepareOrder?.description).toContain('If this request already has lines, keep them');
    expect(tools.prepareOrder?.description).toContain('short customer name');
    expect(tools.prepareOrder?.description).toContain('Do not ask to save the current draft as-is');
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
  expect(prompt).toContain('exact name or VAT');
  expect(prompt).toContain('does not confirm the customer');
  expect(prompt).toContain('call search-clients again with the refined words');
  expect(prompt).toContain('Naming a customer is not a request to copy products');
  expect(prompt).toContain('Keep any product lines already on this request');
  expect(prompt).toContain('# Correct a customer');
  expect(prompt).toContain('short customer name');
  expect(prompt).toContain('not a request to save');
  expect(prompt).toContain('nothing is saved yet');
  expect(prompt).not.toMatch(/\/(?:ordine|cliente|annulla|confermaordine|confermacliente)\b/);
  const fields = orderDraftInput.shape;
  expect(fields.newClient.description).toContain('attached email');
  expect(fields.notes.description).toContain('operator sees it in the draft');
  expect(fields.delivery.description).toContain('never a delivery address');
  expect(fields.clientQuery.description).toContain('search-clients');
  expect(fields.clientQuery.description).toContain('short customer name');
  expect(fields.clientId.description).toContain('do not keep the old id');
  expect(fields.clientId.description).toContain('short customer name');
  expect(fields.lines.description).toContain('A new request starts with no lines');
  expect(fields.lines.description).toContain('If you send none while the open draft has lines, they stay');
});

it('tells the agent to write automatic order notes in the operator language without translating catalogue names', () => {
  const prompt = systemPrompt(config().invoicing.label);
  const notes = orderDraftInput.shape.notes.description ?? '';
  expect(prompt).toContain('Write order notes in that same language');
  expect(prompt).toContain('keep catalogue product names as they appear');
  expect(notes).toContain("same language as the operator's messages");
  expect(notes).toContain('Italian when they write in Italian');
  expect(notes).toContain('English when they write in English');
  expect(notes).toContain('Keep catalogue product names as they appear');
  expect(notes).toContain('do not translate them');
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

it('finds a hotel from street plus a hint when notes only say hotel, and falls back to siblings when a refine misses', async () => {
  const storage = new LibSQLStore({ id: 'client-street-search', url: ':memory:' });
  try {
    const connector = new DemoConnector();
    const { shop, hotel, cafe } = harborSiblings();
    connector.clients.push(shop, hotel, cafe);
    const tools = await createOrderAgent(config(), connector, storage).agent.listTools();
    const search = (query: string) => tools.searchClients!.execute!({ query }, {} as never) as Promise<{ id: string; notes?: string }[]>;
    expect(await search('Fable Harbor hotel')).toEqual([expect.objectContaining({ id: '211', notes: 'hotel' })]);
    expect(await search('Fable Harbor shop')).toEqual([expect.objectContaining({ id: '210' })]);
    expect((await search('Fable Harbor')).map(c => c.id).sort()).toEqual(['210', '211', '212']);
    expect((await search('Fable Harbor spa')).map(c => c.id).sort()).toEqual(['210', '211', '212']);
    expect(await search('Fable Harbor Cafe')).toEqual([expect.objectContaining({ id: '212', notes: 'call after 10' })]);
  } finally { await storage.close(); }
});

it('finds a pharmacy from a one-letter slip on the distinctive name, and does not list every pharmacy for a leftover trade word', async () => {
  const storage = new LibSQLStore({ id: 'client-near-miss-search', url: ':memory:' });
  try {
    const connector = new DemoConnector();
    const { willowmere, cinderford, pebblebrook } = pharmacyTypeAccounts();
    connector.clients.push(willowmere, cinderford, pebblebrook);
    const tools = await createOrderAgent(config(), connector, storage).agent.listTools();
    const search = (query: string) => tools.searchClients!.execute!({ query }, {} as never) as Promise<{ id: string }[]>;
    expect(await search('Willomere Pharmacy')).toEqual([expect.objectContaining({ id: '310' })]);
    expect(await search('Pharmacy Zorblax')).toEqual([]);
  } finally { await storage.close(); }
});

it('suggests a distinctive account when extra query words are only a person name, and still lists two close accounts', async () => {
  const storage = new LibSQLStore({ id: 'client-person-name-search', url: ':memory:' });
  try {
    const connector = new DemoConnector();
    const { agriturismo, streetOnly, east } = willowmereStayAccounts();
    connector.clients.push(agriturismo, streetOnly);
    const tools = await createOrderAgent(config(), connector, storage).agent.listTools();
    const search = (query: string) => tools.searchClients!.execute!({ query }, {} as never) as Promise<{ id: string; contactPerson?: string }[]>;
    expect(await search('Giulia Willowmere')).toEqual([expect.objectContaining({ id: '410' })]);
    expect((await search('Giulia Willowmere')).map(c => c.id)).not.toContain('411');
    connector.clients.push(east);
    expect((await search('Giulia Willowmere')).map(c => c.id).sort()).toEqual(['410', '412']);
    const withPerson = new DemoConnector();
    withPerson.clients.push({ ...agriturismo, contactPerson: 'Giulia Neri' }, streetOnly);
    const personTools = await createOrderAgent(config(), withPerson, storage).agent.listTools();
    expect(await personTools.searchClients!.execute!({ query: 'Giulia Willowmere' }, {} as never)).toEqual([expect.objectContaining({ id: '410', contactPerson: 'Giulia Neri' })]);
  } finally { await storage.close(); }
});

it('suggests a customer from a small extra ending on a distinctive name, prefers an exact neighbour, and still lists two close accounts', async () => {
  const storage = new LibSQLStore({ id: 'client-extra-ending-search', url: ':memory:' });
  try {
    const connector = new DemoConnector();
    const { sample, sampler, east } = sampleNameAccounts();
    connector.clients.push(sample);
    const tools = await createOrderAgent(config(), connector, storage).agent.listTools();
    const search = (query: string) => tools.searchClients!.execute!({ query }, {} as never) as Promise<{ id: string }[]>;
    expect(await search('cliente sampler')).toEqual([expect.objectContaining({ id: '510' })]);
    expect(await search('cliente samp')).toEqual([expect.objectContaining({ id: '510' })]);
    connector.clients.push(sampler);
    expect(await search('cliente sampler')).toEqual([expect.objectContaining({ id: '511' })]);
    connector.clients.push(east);
    expect((await search('cliente sampler')).map(c => c.id)).toEqual(['511']);
    const two = new DemoConnector();
    two.clients.push(sample, east);
    const twoTools = await createOrderAgent(config(), two, storage).agent.listTools();
    expect(((await twoTools.searchClients!.execute!({ query: 'cliente sampler' }, {} as never)) as { id: string }[]).map(c => c.id).sort()).toEqual(['510', '512']);
  } finally { await storage.close(); }
});
