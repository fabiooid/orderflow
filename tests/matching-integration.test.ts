import { expect, it, vi } from 'vitest';
import { createIdentityResolver, type SelectMany } from '../src/matching/resolver.js';
import { matchingConfigSchema } from '../src/matching/config.js';
import { createJevBatchSelector } from '../src/matching/jev-client.js';
import type { SelectionResult } from '../src/matching/types.js';
import { DemoConnector } from '../src/connector/demo.js';
import { createDraftApi } from '../src/assistant/drafts.js';
import { config, draft } from './helpers.js';

const on = matchingConfigSchema.parse({ mode: 'on' });
const context = { orderId: 'test', revision: 1, operatorText: 'Order for the example shop: two small pebble washes. Delivery eight.' };
const result = (status: SelectionResult['status'], selectedId?: number): SelectionResult => ({ status, selectedId,
  evidence: { requestHash: 'test', promptVersion: 'test', retrieval: { complete: true, furtherSearchPossible: false }, elapsedMs: 0, model: 'test-model', confidence: 0.9 } });
const successful: SelectMany = async requests => requests.map(r => result('matched', r.kind === 'client' ? 201 : 101));
const resolver = (connector = new DemoConnector(), selectMany: SelectMany = successful, mode: 'on' | 'shadow' | 'off' = 'on') => createIdentityResolver(config(), connector, { config: { ...on, mode }, selectMany });

it('replaces model IDs with application-validated decisions and preserves price/quantity data', async () => {
  const input = { ...draft(), clientId: 202, lines: [{ query: 'small pebble wash', productId: 102, quantity: 3, netPrice: 9 }] };
  const resolved = await resolver().resolve(input, context);
  expect(resolved.issues).toEqual([]);
  expect(resolved.draft).toMatchObject({ clientId: 201, lines: [{ productId: 101, quantity: 3, netPrice: 9 }] });
  expect(input.clientId).toBe(202);
  expect(resolved.decisions).toHaveLength(2);
  expect(resolved.decisions[1]).toMatchObject({ source: 'jev', model: 'test-model', selectedId: 101 });
});

it.each(['ambiguous', 'no-match', 'unavailable'] as const)('never falls through to lexical matching on %s', async status => {
  const resolved = await resolver(new DemoConnector(), async requests => requests.map(() => result(status))).resolve({ ...draft(), clientId: 201, lines: [{ query: 'Pebble hand wash 250 ml', productId: 101, quantity: 2 }] }, context);
  expect(resolved.issues).toHaveLength(2);
  expect(resolved.draft.clientId).toBeUndefined();
  expect(resolved.draft.lines[0]?.productId).toBeUndefined();
});

it('rejects an ID outside the eligible candidate set even from an injected selector', async () => {
  const resolved = await resolver(new DemoConnector(), async requests => requests.map(() => result('matched', 900))).resolve(draft(), context);
  expect(resolved.issues.every(i => i.matchingStatus === 'unavailable')).toBe(true);
});

it('shadow records judgments without changing any draft fields or adding blocking issues', async () => {
  const input = { ...draft(), clientId: 202, lines: [{ query: 'small pebble wash', productId: 102, quantity: 3 }] };
  const resolved = await resolver(new DemoConnector(), successful, 'shadow').resolve(input, context);
  expect(resolved.draft).toEqual(input);
  expect(resolved.issues).toEqual([]);
  expect(resolved.decisions.some(d => d.selectedId === 101)).toBe(true);
});

it('off mode performs no extra reads, alias retrieval or Jev requests', async () => {
  const connector = new DemoConnector(); const read = vi.spyOn(connector, 'listProducts'); const select = vi.fn(successful);
  expect(await resolver(connector, select, 'off').resolve(draft(), context)).toEqual({ draft: draft(), issues: [], decisions: [] });
  expect(read).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
});

it('uses exact codes and canonical form names without a model ID bypass', async () => {
  const connector = new DemoConnector(); const products = await connector.listProducts(); const p = products.find(p => p.id === 101)!;
  const select = vi.fn(successful);
  const resolved = await resolver(connector, select).resolve({ ...draft(), lines: [{ query: p.code, productId: 999, quantity: 2 }] }, { ...context, operatorText: `Example Studio: ${p.code}` });
  expect(resolved.draft.lines[0]?.productId).toBe(101);
  expect(resolved.decisions[1]?.source).toBe('exact');
  expect(select.mock.calls[0]?.[0]).toHaveLength(0);
});

it('filters shipping, testers and contradictory sizes before semantic selection', async () => {
  const connector = new DemoConnector();
  const products = await connector.listProducts();
  vi.spyOn(connector, 'listProducts').mockResolvedValue([...products,
    { id: 991, code: 'T', name: 'TESTER Pebble wash 250 ml', description: '', netPrice: 3 },
    { id: 992, code: 'BIG', name: 'Pebble wash 1 l', description: '', netPrice: 30 }]);
  const select = vi.fn(successful);
  await resolver(connector, select).resolve({ ...draft(), lines: [{ query: 'pebble wash 250 ml', quantity: 2 }] }, context);
  const candidates = select.mock.calls[0]![0].find(r => r.kind === 'product')!.candidates;
  expect(candidates.map(c => c.id)).not.toEqual(expect.arrayContaining([900]));
  expect(candidates.some(c => [900, 991, 992].includes(c.id))).toBe(false);
});

it('keeps conflicting aliases ambiguous without letting a confident judgment resolve them', async () => {
  const r = createIdentityResolver(config(), new DemoConnector(), { config: on, selectMany: successful,
    aliases: async () => ({ aliases: [{ phrase: 'wash', productId: 101 }, { phrase: 'wash', productId: 102 }], clientAliases: [] }) });
  const resolved = await r.resolve({ ...draft(), lines: [{ query: 'wash', quantity: 2 }] }, context);
  expect(resolved.issues).toContainEqual(expect.objectContaining({ field: 'lines.0', matchingStatus: 'ambiguous' }));
});

it('refreshes identities and evidence on every revision; price changes never enter identity projections', async () => {
  const connector = new DemoConnector(); const read = vi.spyOn(connector, 'listProducts');
  const r = resolver(connector); const first = await r.resolve(draft(), context);
  const products = await connector.listProducts();
  read.mockResolvedValue(products.filter(p => p.id !== 101));
  const next = await r.resolve(first.draft, { ...context, revision: 2, operatorText: 'Make it three' });
  expect(next.issues).toContainEqual(expect.objectContaining({ field: 'lines.0', matchingStatus: 'unavailable' }));
  expect(next.decisions[1]?.inputHash).not.toBe(first.decisions[1]?.inputHash);
  expect(next.decisions[1]?.candidateHash).not.toBe(first.decisions[1]?.candidateHash);
});

it('batches independent questions with isolated state and validated per-question results', async () => {
  const transport = vi.fn(async (request: any) => ({ model: 'test-model', usage: { input_tokens: 20, output_tokens: 10 },
    answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'choice', choice: 'candidate_0', confidence: 1,
      probabilities: { candidate_0: 1, ambiguous: 0, no_match: 0 } }])) }));
  const select = createJevBatchSelector(on, transport);
  const results = await select(['product', 'client'].map((kind, i) => ({ kind: kind as 'product' | 'client', query: 'example', candidates: [{ id: i + 1, name: 'Example' }], retrieval: { complete: true, furtherSearchPossible: false } })));
  expect(transport).toHaveBeenCalledTimes(1);
  expect(results.map(r => r.selectedId)).toEqual([1, 2]);
  expect(transport.mock.calls[0]![0].questions.item_0.instructions[0]).toContain('state.item_0');
});

it('oversized complete sets fail closed rather than silently using a top-15 shortlist', async () => {
  const connector = new DemoConnector(); const products = await connector.listProducts();
  vi.spyOn(connector, 'listProducts').mockResolvedValue([...products, ...Array.from({ length: 254 }, (_, i) => ({ id: i + 1000, code: `P${i}`, name: `Soap ${i}`, description: '', netPrice: 1 }))]);
  const transport = vi.fn();
  const r = createIdentityResolver(config(), connector, { config: on, selectMany: createJevBatchSelector(on, transport) });
  const resolved = await r.resolve({ ...draft(), lines: [{ query: 'soap', quantity: 2 }] }, { ...context, operatorText: 'Example Studio soap' });
  expect(resolved.issues).toContainEqual(expect.objectContaining({ field: 'lines.0', matchingStatus: 'unavailable' }));
  expect(transport).not.toHaveBeenCalled();
});

it('new clients require a complete no-match; semantic duplicate or outage prevents preparation', async () => {
  const connector = new DemoConnector(); const [client] = await connector.listClients();
  const { id, ...newClient } = client!;
  const input = { ...draft(), clientQuery: 'New trading name', newClient, lines: [] };
  const resolved = await resolver(connector).resolve(input, context);
  expect(resolved.issues[0]).toMatchObject({ field: 'client', matchingStatus: 'ambiguous' });
  const missing = await resolver(connector, async requests => requests.map(() => result('no-match'))).resolve(input, context);
  expect(missing.issues).toEqual([]);
});

it('the order API re-resolves every call and never calculates totals for unresolved identities', async () => {
  const connector = new DemoConnector(); const totals = vi.spyOn(connector, 'calculateTotals');
  const select = vi.fn<SelectMany>().mockImplementationOnce(async requests => requests.map(() => result('ambiguous'))).mockImplementation(successful);
  const drafts = createDraftApi(config(), connector, resolver(connector, select));
  const first = await drafts.order({ ...draft(), clientId: 202 }, context, '2026-10-08');
  expect(first.status).toBe('needs'); expect(totals).not.toHaveBeenCalled();
  const next = await drafts.order({ ...draft(), clientId: 202 }, { ...context, operatorText: 'Use the small pebble wash for the example shop', revision: 2 }, '2026-10-08');
  expect(next.status).toBe('ready');
  if (next.status === 'ready') {
    expect(next.order.client.id).toBe(201);
    expect(next.order.lines[0]?.productId).toBe(101);
    expect(next.decisions).toHaveLength(2);
  }
  expect(select).toHaveBeenCalledTimes(2); expect(connector.createCalls).toBe(0);
});

it('operator button choices bypass the model but remain limited to current records', async () => {
  const connector = new DemoConnector(); const select = vi.fn(successful);
  const input = { ...draft(), lines: [{ query: 'wash', productId: 102, quantity: 2, documentPrice: { amount: 9, basis: 'net' as const, decision: 'document' as const } }] };
  const r = resolver(connector, select);
  const resolved = await r.resolve(input, { ...context, choice: { field: 'lines.0', id: 101 } });
  expect(resolved.draft.lines[0]).toMatchObject({ productId: 101, quantity: 2, documentPrice: { decision: 'pending' } });
  expect(resolved.decisions[1]?.source).toBe('operator');
  const missing = await r.resolve(input, { ...context, choice: { field: 'lines.0', id: 999999 } });
  expect(missing.issues.some(i => i.field === 'lines.0')).toBe(true);
  expect(missing.draft.lines[0]?.productId).toBeUndefined();
});

it('an explicit code cannot silently turn into a different size or a tester', async () => {
  const connector = new DemoConnector(); const products = await connector.listProducts();
  const p = products.find(p => p.id === 101)!;
  vi.spyOn(connector, 'listProducts').mockResolvedValue([...products, { id: 991, code: 'T', name: 'TESTER Pebble wash 250 ml', description: '', netPrice: 3 }]);
  const select = vi.fn(successful);
  const r = resolver(connector, select);
  await r.resolve({ ...draft(), lines: [{ query: `${p.code} 500 ml`, quantity: 2 }] }, context);
  expect(select.mock.calls[0]![0].find(r => r.kind === 'product')!.candidates).toEqual([]);
  await r.resolve({ ...draft(), lines: [{ query: 'wash 250 ml, non tester', quantity: 2 }] }, context);
  expect(select.mock.calls[1]![0].find(r => r.kind === 'product')!.candidates.some(c => c.id === 991)).toBe(false);
});

it('keeps explicit choices stable through quantity/price changes and invalidates changed identity data', async () => {
  const { confirmedChoices } = await import('../src/matching/resolver.js');
  const connector = new DemoConnector(); const select = vi.fn(successful); const r = resolver(connector, select);
  const first = await r.resolve({ ...draft(), lines: [{ query: 'wash', quantity: 2 }] }, { ...context, choice: { field: 'lines.0', id: 101 } });
  const choices = confirmedChoices(first.decisions);
  connector.products[0]!.netPrice = 99;
  const next = await r.resolve({ ...first.draft, lines: [{ ...first.draft.lines[0]!, quantity: 3 }] }, { ...context, revision: 2, operatorText: 'Make it three', confirmedChoices: choices });
  expect(next.draft.lines[0]).toMatchObject({ productId: 101, quantity: 3 });
  expect(next.decisions[1]?.source).toBe('operator');
  expect(select.mock.calls.at(-1)![0].some(r => r.kind === 'product')).toBe(false);
  connector.products[0]!.name = 'Different product';
  await r.resolve(first.draft, { ...context, revision: 3, confirmedChoices: choices });
  expect(select.mock.calls.at(-1)![0].some(r => r.kind === 'product')).toBe(true);
});

it('does not calculate totals when fresh preparation data differs from the judged snapshot', async () => {
  const connector = new DemoConnector(); const products = await connector.listProducts();
  vi.spyOn(connector, 'listProducts').mockResolvedValueOnce(products).mockResolvedValue([...products, { id: 993, code: 'OTHER', name: 'Another plausible pebble wash', description: '', netPrice: 10 }]);
  const totals = vi.spyOn(connector, 'calculateTotals');
  expect((await createDraftApi(config(), connector, resolver(connector)).order(draft(), { ...context, orderId: 'freshness' }, '2026-10-08')).status).toBe('needs');
  expect(totals).not.toHaveBeenCalled();
});

it('an explicit ID disambiguates duplicate canonical product names', async () => {
  const connector = new DemoConnector(); connector.products.push({ ...connector.products[0]!, id: 994, code: 'DUPLICATE' });
  const resolved = await resolver(connector).resolve(draft(), { ...context, operatorText: 'Pebble hand wash 250 ml', choice: { field: 'lines.0', id: 994 } });
  expect(resolved.draft.lines[0]?.productId).toBe(994);
  expect(resolved.decisions[1]?.source).toBe('operator');
});

it('excludes a matching VAT record when its city contradicts the requested catalogue city', async () => {
  const connector = new DemoConnector();
  const base = connector.clients[0]!;
  connector.clients.splice(0, connector.clients.length,
    { ...base, id: 201, name: 'Rossi', city: 'Milano', vatNumber: 'IT00000000001' },
    { ...base, id: 202, name: 'Rossi', city: 'Roma', vatNumber: 'IT00000000002' });
  const select = vi.fn<SelectMany>(async requests => requests.map(r => r.candidates.length ? result('matched', r.candidates[0]!.id) : result('no-match')));
  const query = 'Rossi Milano con partita IVA IT00000000002';
  const resolved = await resolver(connector, select).resolve({ ...draft(), clientQuery: query, lines: [] }, { ...context, operatorText: query });
  expect(select.mock.calls[0]![0][0]!.candidates).toEqual([]);
  expect(resolved.decisions[0]?.status).toBe('no-match');
  expect(resolved.draft.clientId).toBeUndefined();
});

it('lets the named customer replace a different company read from a document, like a product correction', async () => {
  const connector = new DemoConnector();
  connector.clients.push({ id: 300, name: 'Harbor Goods Srl', country: 'IT', street: 'Example Wharf 4', city: 'Example City', postalCode: '00000', vatNumber: 'IT00000000999', notes: '' });
  const selectMany = vi.fn<SelectMany>(async requests => requests.map(r => result('matched', r.kind === 'client' ? 201 : 101)));
  const harbor = { name: 'Harbor Goods Srl', country: 'IT', street: 'Example Wharf 4', city: 'Example City', postalCode: '00000', vatNumber: 'IT00000000999' };
  const input = { ...draft(), clientQuery: 'Example Studio', newClient: harbor, lines: [] };
  const resolved = await resolver(connector, selectMany).resolve(input, { ...context, operatorText: 'Order for Example Studio\n[Content read from attachments]\nHarbor Goods Srl P.IVA IT00000000999' });
  expect(resolved.issues).toEqual([]);
  expect(resolved.draft.clientId).toBe(201);
  expect(resolved.draft.newClient).toBeUndefined();
  // The same company under a shorter name keeps its document details.
  const same = await resolver(connector, selectMany).resolve({ ...input, clientQuery: 'Harbor Goods' }, { ...context, operatorText: 'Order for Harbor Goods' });
  expect(same.draft.newClient?.vatNumber).toBe('IT00000000999');
});

it('reads catalogue litres written as "5lt" so a "5 L" request keeps them as candidates', async () => {
  const connector = new DemoConnector();
  connector.products.push({ id: 500, code: 'DEMO-5L', name: 'Cedar wash 5lt', description: '', netPrice: 18 },
    { id: 501, code: 'DEMO-500', name: 'Cedar wash 500ml', description: '', netPrice: 8 });
  const selectMany = vi.fn<SelectMany>(async requests => requests.map(r => result('matched', r.kind === 'client' ? 201 : 500)));
  await resolver(connector, selectMany).resolve({ ...draft(), clientId: 201, lines: [{ query: 'Refill 5 L Cedar wash', quantity: 1 }] }, context);
  const product = selectMany.mock.calls[0]![0].find(r => r.kind === 'product')!;
  expect(product.candidates.map(c => c.id)).toEqual([500]);
});
