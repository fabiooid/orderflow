import { expect, it } from 'vitest';
import { z } from 'zod';
import { LibSQLStore } from '@mastra/libsql';
import { RequestContext } from '@mastra/core/request-context';
import { createOrderAgent, sharedKnowledgeSchema } from '../src/assistant/agent.js';
import { replySchema } from '../src/channel/engine.js';
import { orderDraftInput } from '../src/assistant/draft-schema.js';
import { systemPrompt } from '../src/assistant/system-prompt.js';
import { startTurn, turnOf } from '../src/assistant/turn-context.js';
import { DemoConnector } from '../src/connector/demo.js';
import { config, harborSiblings, monasterySiblings, pharmacyTypeAccounts, sampleNameAccounts, willowmereStayAccounts } from './helpers.js';

it('gives the agent the order and customer APIs and lookups, and no way to save', async () => {
  const storage = new LibSQLStore({ id: 'agent-tools', url: ':memory:' });
  try {
    const { agent } = createOrderAgent(config(), new DemoConnector(), storage);
    const tools = await agent.listTools();
    expect(Object.keys(tools).sort()).toEqual(['cancelRequest', 'getCustomerOrderHistory', 'prepareCustomer', 'prepareOrder', 'rememberAlias', 'searchClients', 'searchProducts']);
    expect(tools.searchClients?.description).toContain('everyday name');
    expect(tools.searchClients?.description).toContain('One close account is still a question');
    expect(tools.searchClients?.description).toContain('exact name or VAT');
    expect(tools.searchClients?.description).toContain('candidates, not as a lock');
    expect(tools.searchClients?.description).toContain('Search does not change the draft');
    expect(tools.searchProducts?.description).toContain('not in the catalogue');
    expect(tools.searchProducts?.description).toContain('found=catalogue is not identity evidence');
    expect(tools.prepareOrder?.description).toContain('Empty lines keep rows already on this request');
    expect(tools.prepareOrder?.description).toContain('Search does not open or change a draft');
    expect(tools.prepareCustomer?.description).toContain('Missing email or VAT');
    expect(tools.prepareOrder?.description).toContain('unique SKUs/testers');
    expect(tools.prepareOrder?.description).toContain('Do not claim ready while the result status is needs');
    expect(tools.prepareOrder?.description).not.toContain('always call search-clients first');
    expect(Object.values(tools).every(tool => !/creates?|saves?|writes?/i.test(tool.id))).toBe(true);
    expect(await agent.listSkills()).toEqual([]);
  } finally { await storage.close(); }
});

it('keeps business rules in the prompt and field rules in the API schema, with no slash commands', () => {
  const prompt = systemPrompt(config().invoicing.label);
  expect(prompt).toContain('Never create invoices or proformas');
  expect(prompt).toContain('Only the operator saves');
  expect(prompt).toContain('out of scope');
  expect(prompt).toContain('# How to work');
  expect(prompt).toContain('exact legal name or VAT');
  expect(prompt).toContain('"Yes, prepare this file" does not confirm a customer');
  expect(prompt).toContain('A single fuzzy search hit is not a lock');
  expect(prompt).toContain('do not invent or append catalogue codes');
  expect(prompt).toContain('Search-products only when');
  expect(prompt).toContain('not in the catalogue');
  expect(prompt).toContain('Empty lines keep the open draft');
  expect(prompt).toContain('Catalogue prices apply unless they state a unit price');
  expect(prompt).toContain('Supplier letterhead is not the customer');
  expect(prompt).toContain('customer.status');
  expect(prompt).toContain('Never say the draft is ready while status is needs');
  expect(prompt).toContain('short customer name');
  expect(prompt).toContain('not a request to save');
  expect(prompt).toContain('Search does not open or change a draft');
  expect(prompt).toContain('Missing customer email or VAT does not block starting an order');
  expect(prompt).toContain('An explicit shipping 0 already on this request stays');
  expect(prompt).not.toContain('always call search-clients');
  expect(prompt).not.toMatch(/\/(?:ordine|cliente|annulla|confermaordine|confermacliente)\b/);
  const fields = orderDraftInput.shape;
  expect(fields.newClient.description).toContain('operator says the customer is new');
  expect(fields.notes.description).toContain('only a note the operator asked to write');
  expect(fields.delivery.description).toContain("other than the customer's own address");
  expect(fields.clientQuery.description).toContain('Do not copy a cancelled request');
  expect(fields.clientQuery.description).toContain('Letterhead is not a customer');
  expect(fields.lines.element.shape.documentPrice.description).toContain('Null when none is pending');
  expect(fields.clientId.description).toContain('yes-prepare-this-file is not an id');
  expect(fields.lines.description).toContain('Empty keeps the open draft');
  expect(fields.lines.description).toContain('A new request starts empty');
});

it('tells the agent to write automatic order notes in the operator language without translating catalogue names', () => {
  const prompt = systemPrompt(config().invoicing.label);
  const notes = orderDraftInput.shape.notes.description ?? '';
  expect(prompt).toContain('Write notes in that language');
  expect(prompt).toContain('keep catalogue names as they appear');
  expect(notes).toContain('Same language as the operator');
  expect(notes).toContain('do not translate catalogue names');
});

it('tells the agent to put only the requested instruction in order notes', () => {
  const prompt = systemPrompt(config().invoicing.label);
  const notes = orderDraftInput.shape.notes.description ?? '';
  expect(prompt).toContain('Leave shipping, discounts and notes empty unless they stated them this request');
  expect(notes).toContain('only a note the operator asked to write');
  expect(notes).toContain('Empty when they did not');
  expect(notes).not.toContain("customer's message");
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
    expect(await search('DEMO-A | Qty: 2')).toMatchObject({ found: 'words', products: [{ id: '101' }] });
    const soaps = await search('saponi');
    expect(soaps.found).toBe('catalogue');
    expect(soaps.products.map(p => p.name)).toContain('Pebble hand wash 250 ml');
    expect((await search('')).found).toBe('catalogue');
    const context = new RequestContext();
    startTurn(context, { evidence: 'saponi', operatorWords: 'saponi', senderId: '1', knownPhrases: [] });
    await tools.searchProducts!.execute!({ query: 'saponi' }, { requestContext: context } as never);
    expect(turnOf(context)?.searchEvidence).toEqual([]);
    await tools.searchProducts!.execute!({ query: 'candle' }, { requestContext: context } as never);
    expect(turnOf(context)?.searchEvidence).toEqual([expect.objectContaining({ kind: 'product', query: 'candle', ids: expect.arrayContaining(['103']) })]);
  } finally { await storage.close(); }
});

it('marks a missing combination as related and returns products for each requested word', async () => {
  const storage = new LibSQLStore({ id: 'agent-related-search', url: ':memory:' });
  try {
    const connector = new DemoConnector();
    connector.products.push(
      { id: '105', code: 'DEMO-FIG-GEL', name: 'Fig shower gel 250 ml', description: '', netPrice: 14 },
      { id: '106', code: 'DEMO-CEDAR-SOAP', name: 'Cedar hand soap 250 ml', description: '', netPrice: 12 },
    );
    const tools = await createOrderAgent(config(), connector, storage).agent.listTools();
    const result = await tools.searchProducts!.execute!({ query: 'fig hand soap' }, {} as never) as { found: string; products: { name: string }[] };
    expect(result.found).toBe('related');
    expect(result.products.map(p => p.name)).toEqual(expect.arrayContaining(['Fig shower gel 250 ml', 'Cedar hand soap 250 ml']));
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
    const search = async (query: string) => {
      const result = await tools.searchClients!.execute!({ query }, {} as never) as { found: number; clients: { id: string; notes?: string }[] };
      expect(result.found).toBe(result.clients.length);
      return result.clients;
    };
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
    const search = async (query: string) => ((await tools.searchClients!.execute!({ query }, {} as never)) as { clients: { id: string; notes?: string }[] }).clients;
    expect(await search('Fable Harbor hotel')).toEqual([expect.objectContaining({ id: '211', notes: 'hotel' })]);
    expect(await search('Fable Harbor shop')).toEqual([expect.objectContaining({ id: '210' })]);
    expect((await search('Fable Harbor')).map(c => c.id).sort()).toEqual(['210', '211', '212']);
    expect((await search('Fable Harbor spa')).map(c => c.id).sort()).toEqual(['210', '211', '212']);
    expect(await search('Fable Harbor Cafe')).toEqual([expect.objectContaining({ id: '212', notes: 'call after 10' })]);
  } finally { await storage.close(); }
});

it('finds the hotel from notes that hold the everyday name, and a shop/store/negozio hint still finds the shop', async () => {
  const storage = new LibSQLStore({ id: 'client-monastery-search', url: ':memory:' });
  try {
    const connector = new DemoConnector();
    const { shop, hotel } = monasterySiblings();
    connector.clients.push(shop, hotel);
    const tools = await createOrderAgent(config(), connector, storage).agent.listTools();
    const search = async (query: string) => ((await tools.searchClients!.execute!({ query }, {} as never)) as { clients: { id: string; notes?: string; street?: string }[] }).clients;
    expect(await search('Harbour hotel')).toEqual([expect.objectContaining({ id: '221', notes: 'Harbour Hotel' })]);
    expect(await search('Harbour albergo')).toEqual([expect.objectContaining({ id: '221' })]);
    expect(await search('Harbour shop')).toEqual([expect.objectContaining({ id: '220' })]);
    expect(await search('Harbour store')).toEqual([expect.objectContaining({ id: '220' })]);
    expect(await search('Harbour negozio')).toEqual([expect.objectContaining({ id: '220' })]);
    expect((await search('Harbour')).map(c => c.id).sort()).toEqual(['220', '221']);
    expect(await search('Harbour hotel')).toEqual([expect.objectContaining({ street: 'Monastery Walk 1' })]);
  } finally { await storage.close(); }
});

it('finds a pharmacy from a one-letter slip on the distinctive name, and does not list every pharmacy for a leftover trade word', async () => {
  const storage = new LibSQLStore({ id: 'client-near-miss-search', url: ':memory:' });
  try {
    const connector = new DemoConnector();
    const { willowmere, cinderford, pebblebrook } = pharmacyTypeAccounts();
    connector.clients.push(willowmere, cinderford, pebblebrook);
    const tools = await createOrderAgent(config(), connector, storage).agent.listTools();
    const search = async (query: string) => ((await tools.searchClients!.execute!({ query }, {} as never)) as { found: number; clients: { id: string }[] }).clients;
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
    const search = async (query: string) => ((await tools.searchClients!.execute!({ query }, {} as never)) as { clients: { id: string; contactPerson?: string }[] }).clients;
    expect(await search('Giulia Willowmere')).toEqual([expect.objectContaining({ id: '410' })]);
    expect((await search('Giulia Willowmere')).map(c => c.id)).not.toContain('411');
    connector.clients.push(east);
    expect((await search('Giulia Willowmere')).map(c => c.id).sort()).toEqual(['410', '412']);
    const withPerson = new DemoConnector();
    withPerson.clients.push({ ...agriturismo, contactPerson: 'Giulia Neri' }, streetOnly);
    const personTools = await createOrderAgent(config(), withPerson, storage).agent.listTools();
    expect(((await personTools.searchClients!.execute!({ query: 'Giulia Willowmere' }, {} as never)) as { clients: { id: string }[] }).clients).toEqual([expect.objectContaining({ id: '410', contactPerson: 'Giulia Neri' })]);
  } finally { await storage.close(); }
});

it('suggests a customer from a small extra ending on a distinctive name, prefers an exact neighbour, and still lists two close accounts', async () => {
  const storage = new LibSQLStore({ id: 'client-extra-ending-search', url: ':memory:' });
  try {
    const connector = new DemoConnector();
    const { sample, sampler, east } = sampleNameAccounts();
    connector.clients.push(sample);
    const tools = await createOrderAgent(config(), connector, storage).agent.listTools();
    const search = async (query: string) => ((await tools.searchClients!.execute!({ query }, {} as never)) as { clients: { id: string }[] }).clients;
    expect(await search('cliente sampler')).toEqual([expect.objectContaining({ id: '510' })]);
    expect(await search('cliente samp')).toEqual([expect.objectContaining({ id: '510' })]);
    connector.clients.push(sampler);
    expect(await search('cliente sampler')).toEqual([expect.objectContaining({ id: '511' })]);
    connector.clients.push(east);
    expect((await search('cliente sampler')).map(c => c.id)).toEqual(['511']);
    const two = new DemoConnector();
    two.clients.push(sample, east);
    const twoTools = await createOrderAgent(config(), two, storage).agent.listTools();
    expect(((await twoTools.searchClients!.execute!({ query: 'cliente sampler' }, {} as never)) as { clients: { id: string }[] }).clients.map(c => c.id).sort()).toEqual(['510', '512']);
  } finally { await storage.close(); }
});
