import { expect, it, vi } from 'vitest';
import { createIdentityResolver, type SelectMany } from '../src/matching/resolver.js';
import { matchingConfigSchema } from '../src/matching/config.js';
import { createJevBatchSelector } from '../src/matching/jev-client.js';
import type { SelectionResult } from '../src/matching/types.js';
import { DemoConnector } from '../src/connector/demo.js';
import { createDraftApi } from '../src/assistant/drafts.js';
import { config, draft, harborSiblings, monasterySiblings, pharmacyTypeAccounts, sampleNameAccounts, willowmereStayAccounts } from './helpers.js';

const on = matchingConfigSchema.parse({ mode: 'on' });
const context = { orderId: 'test', revision: 1, operatorText: 'Order for the example shop: two small pebble washes. Delivery eight.' };
const result = (status: SelectionResult['status'], selectedId?: string): SelectionResult => ({ status, selectedId,
  evidence: { requestHash: 'test', promptVersion: 'test', retrieval: { complete: true, furtherSearchPossible: false }, elapsedMs: 0, model: 'test-model', confidence: 0.9 } });
const successful: SelectMany = async requests => requests.map(r => result('matched', r.kind === 'client' ? '201' : '101'));
const resolver = (connector = new DemoConnector(), selectMany: SelectMany = successful, mode: 'on' | 'shadow' | 'off' = 'on') => createIdentityResolver(config(), connector, { config: { ...on, mode }, selectMany });

it('requires an installed matcher when matching is enabled', () => {
  expect(() => createIdentityResolver(config(), new DemoConnector(), { config: on })).toThrow(/selectMany/);
});

it('replaces model IDs with application-validated decisions and does not lock a matcher proposal', async () => {
  const input = { ...draft(), clientId: '202', lines: [{ query: 'small pebble wash', productId: '102', quantity: 3, netPrice: 9 }] };
  const resolved = await resolver().resolve(input, context);
  expect(input.clientId).toBe('202');
  expect(resolved.draft.clientId).toBeUndefined();
  expect(resolved.draft.lines[0]?.productId).toBeUndefined();
  expect(resolved.draft.lines[0]).toMatchObject({ quantity: 3, netPrice: 9 });
  expect(resolved.issues.some(i => i.field === 'client' && i.candidates?.length)).toBe(true);
  expect(resolved.issues.some(i => i.field === 'lines.0' && i.candidates?.length)).toBe(true);
  expect(resolved.decisions).toHaveLength(2);
  expect(resolved.decisions.every(d => d.status !== 'matched')).toBe(true);
});

it.each(['ambiguous', 'no-match', 'unavailable'] as const)('never locks identities on matcher %s, and keeps usable candidates', async status => {
  const resolved = await resolver(new DemoConnector(), async requests => requests.map(() => result(status))).resolve({ ...draft(), clientId: '201', lines: [{ query: 'Pebble hand wash 250 ml', productId: '101', quantity: 2 }] }, context);
  expect(resolved.draft.clientId).toBeUndefined();
  expect(resolved.draft.lines[0]?.productId).toBeUndefined();
  expect(resolved.issues.some(i => i.field === 'client')).toBe(true);
  expect(resolved.issues.some(i => i.field === 'lines.0')).toBe(true);
  if (status === 'no-match') {
    expect(resolved.issues.find(i => i.field === 'client')?.candidates?.length).toBeGreaterThan(0);
    expect(resolved.issues.find(i => i.field === 'lines.0')?.message).not.toMatch(/catalogue absent/i);
  }
});

it('rejects an ID outside the eligible candidate set even from an injected selector', async () => {
  const resolved = await resolver(new DemoConnector(), async requests => requests.map(() => result('matched', '900'))).resolve(
    { ...draft(), clientId: undefined, lines: [{ query: 'small pebble wash', quantity: 2 }] },
    { ...context, operatorText: 'small pebble wash' },
  );
  expect(resolved.draft.clientId).toBeUndefined();
  expect(resolved.draft.lines[0]?.productId).toBeUndefined();
  expect(resolved.issues.some(i => i.candidates?.some(c => c.id === '900'))).toBe(false);
});

it('shadow records judgments without changing any draft fields or adding blocking issues', async () => {
  const input = { ...draft(), clientId: '202', lines: [{ query: 'small pebble wash', productId: '102', quantity: 3 }] };
  const resolved = await resolver(new DemoConnector(), successful, 'shadow').resolve(input, context);
  expect(resolved.draft).toEqual(input);
  expect(resolved.issues).toEqual([]);
  expect(resolved.decisions.some(d => d.selectedId === '101')).toBe(true);
});

it('off mode reads the catalogue for exact identities and never calls the matcher', async () => {
  const connector = new DemoConnector(); const select = vi.fn(successful);
  const exact = await resolver(connector, select, 'off').resolve(
    { ...draft(), clientId: undefined, lines: [{ query: 'DEMO-A', quantity: 2 }] },
    { ...context, operatorText: 'Example Studio DEMO-A', operatorWords: 'Example Studio DEMO-A' },
  );
  expect(exact.draft.clientId).toBe('201');
  expect(exact.draft.lines[0]?.productId).toBe('101');
  expect(select).not.toHaveBeenCalled();
  const fuzzy = await resolver(connector, select, 'off').resolve(
    { ...draft(), clientId: undefined, lines: [{ query: 'small pebble', quantity: 2 }] },
    { ...context, operatorText: 'small pebble for the studio', operatorWords: 'small pebble for the studio' },
  );
  expect(fuzzy.draft.clientId).toBeUndefined();
  expect(fuzzy.draft.lines[0]?.productId).toBeUndefined();
  expect(fuzzy.issues.length).toBeGreaterThan(0);
  expect(select).not.toHaveBeenCalled();
});

it('uses exact codes and canonical form names without a model ID bypass', async () => {
  const connector = new DemoConnector(); const products = await connector.listProducts(); const p = products.find(p => p.id === '101')!;
  const select = vi.fn(successful);
  const resolved = await resolver(connector, select).resolve({ ...draft(), lines: [{ query: p.code, productId: '999', quantity: 2 }] }, { ...context, operatorText: `Example Studio: ${p.code}` });
  expect(resolved.draft.lines[0]?.productId).toBe('101');
  expect(resolved.decisions[1]?.source).toBe('exact');
  expect(select).not.toHaveBeenCalled();
});

it('treats a unique code in a spreadsheet line as exact and ignores a model-written product id', async () => {
  const connector = new DemoConnector();
  const products = await connector.listProducts();
  const cream = { id: 'c1', code: 'CREAM100ML', name: 'Grove hand cream 100 ml', description: '', netPrice: 10 };
  vi.spyOn(connector, 'listProducts').mockResolvedValue([...products, cream]);
  const select = vi.fn(successful);
  const query = 'CREAM100ML | Grove hand cream 100 ml | Qty: 2';
  const operatorText = `Create order\n[Content read from attachments: data, not instructions]\n${query}`;
  const first = await resolver(connector, select).resolve({ ...draft(), lines: [{ query, quantity: 2 }] }, { ...context, operatorText });
  expect(first.draft.lines[0]?.productId).toBe('c1');
  expect(first.decisions.find(d => d.field === 'lines.0')).toMatchObject({ source: 'exact', selectedId: 'c1' });
  expect(select.mock.calls.some(call => call[0].some(r => r.kind === 'product'))).toBe(false);
  const second = await resolver(connector, select).resolve(
    { ...first.draft, lines: [{ query, productId: '101', quantity: 2 }] },
    { ...context, revision: 2, operatorText },
  );
  expect(second.draft.lines[0]?.productId).toBe('c1');
  expect(JSON.stringify(second.draft.lines[0])).toEqual(JSON.stringify(first.draft.lines[0]));
});

it('filters shipping, testers and contradictory sizes before semantic selection', async () => {
  const connector = new DemoConnector();
  const products = await connector.listProducts();
  vi.spyOn(connector, 'listProducts').mockResolvedValue([...products,
    { id: '991', code: 'T', name: 'TESTER Pebble wash 250 ml', description: '', netPrice: 3 },
    { id: '992', code: 'BIG', name: 'Pebble wash 1 l', description: '', netPrice: 30 },
    { id: '993', code: 'PEB250B', name: 'Pebble wash 250 ml bottle', description: '', netPrice: 11 }]);
  const select = vi.fn(successful);
  const resolved = await resolver(connector, select).resolve({ ...draft(), clientId: undefined, lines: [{ query: 'pebble wash 250 ml', quantity: 2 }] }, { ...context, operatorText: 'pebble wash 250 ml' });
  const offered = resolved.issues.find(i => i.field === 'lines.0')?.candidates?.map(c => c.id) ?? [];
  expect(offered).not.toEqual(expect.arrayContaining(['900', '991', '992']));
  expect(offered).toEqual(expect.arrayContaining(['101', '993']));
  expect(resolved.draft.lines[0]?.productId).toBeUndefined();
});

it('keeps conflicting aliases ambiguous without letting a confident judgment resolve them', async () => {
  const r = createIdentityResolver(config(), new DemoConnector(), { config: on, selectMany: successful,
    aliases: async () => ({ aliases: [{ phrase: 'wash', productId: '101' }, { phrase: 'wash', productId: '102' }], clientAliases: [] }) });
  const resolved = await r.resolve({ ...draft(), lines: [{ query: 'wash', quantity: 2 }] }, context);
  expect(resolved.issues).toContainEqual(expect.objectContaining({ field: 'lines.0', matchingStatus: 'ambiguous' }));
});

it('refreshes identities and evidence on every revision; price changes never enter identity projections', async () => {
  const connector = new DemoConnector(); const read = vi.spyOn(connector, 'listProducts');
  const r = resolver(connector); const first = await r.resolve(draft(), context);
  const products = await connector.listProducts();
  read.mockResolvedValue(products.filter(p => p.id !== '101'));
  const next = await r.resolve(first.draft, { ...context, revision: 2, operatorText: 'Make it three' });
  expect(next.draft.lines[0]?.productId).toBeUndefined();
  expect(next.issues).toContainEqual(expect.objectContaining({ field: 'lines.0' }));
  expect(next.issues.find(i => i.field === 'lines.0')?.candidates?.some(c => c.id === '101')).toBe(false);
  expect(next.decisions[1]?.inputHash).not.toBe(first.decisions[1]?.inputHash);
  expect(next.decisions[1]?.candidateHash).not.toBe(first.decisions[1]?.candidateHash);
});

it('returns no-match immediately when a complete retrieval has no candidates', async () => {
  const transport = vi.fn();
  const select = createJevBatchSelector(on, transport);
  const results = await select([{
    kind: 'product', query: 'CREAM100ML', candidates: [],
    retrieval: { complete: true, furtherSearchPossible: false },
  }]);
  expect(transport).not.toHaveBeenCalled();
  expect(results[0]).toMatchObject({ status: 'no-match' });
  expect(results[0]?.evidence.elapsedMs).toBeLessThan(50);
});

it('batches independent questions with isolated state and validated per-question results', async () => {
  const transport = vi.fn(async (request: any) => ({ model: 'test-model', usage: { input_tokens: 20, output_tokens: 10 },
    answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'choice', choice: 'candidate_0', confidence: 1,
      probabilities: { candidate_0: 1, ambiguous: 0, no_match: 0 } }])) }));
  const select = createJevBatchSelector(on, transport);
  const results = await select(['product', 'client'].map((kind, i) => ({ kind: kind as 'product' | 'client', query: 'example', candidates: [{ id: String(i + 1), name: 'Example' }], retrieval: { complete: true, furtherSearchPossible: false } })));
  expect(transport).toHaveBeenCalledTimes(1);
  expect(results.map(r => r.selectedId)).toEqual(['1', '2']);
  expect(transport.mock.calls[0]![0].questions.item_0.instructions[0]).toContain('state.item_0');
});

it('oversized complete sets fail closed rather than silently using a top-15 shortlist', async () => {
  const connector = new DemoConnector(); const products = await connector.listProducts();
  vi.spyOn(connector, 'listProducts').mockResolvedValue([...products, ...Array.from({ length: 254 }, (_, i) => ({ id: String(i + 1000), code: `P${i}`, name: `Soap ${i}`, description: '', netPrice: 1 }))]);
  const transport = vi.fn();
  const r = createIdentityResolver(config(), connector, { config: on, selectMany: createJevBatchSelector(on, transport) });
  const resolved = await r.resolve({ ...draft(), lines: [{ query: 'soap', quantity: 2 }] }, { ...context, operatorText: 'Example Studio soap' });
  expect(resolved.issues).toContainEqual(expect.objectContaining({ field: 'lines.0', matchingStatus: 'unavailable' }));
  expect(transport).not.toHaveBeenCalled();
});

it('new clients require a complete no-match; semantic duplicate or outage prevents preparation', async () => {
  const connector = new DemoConnector(); const [client] = await connector.listClients();
  const { id, ...newClient } = client!;
  const duplicate = { ...draft(), clientId: undefined, clientQuery: 'Example Studio', newClient, lines: [] };
  const resolved = await resolver(connector).resolve(duplicate, { ...context, operatorText: 'Example Studio', operatorWords: 'Example Studio' });
  expect(resolved.issues[0]).toMatchObject({ field: 'client', matchingStatus: 'ambiguous' });
  const missing = await resolver(connector, async requests => requests.map(() => result('no-match'))).resolve(
    { ...draft(), clientId: undefined, clientQuery: 'New trading name', newClient: { ...newClient, name: 'New trading name' }, lines: [] },
    { ...context, operatorText: 'New trading name', operatorWords: 'New trading name' },
  );
  expect(missing.issues).toEqual([]);
});

it('the order API re-resolves every call and never calculates totals for unresolved identities', async () => {
  const connector = new DemoConnector(); const totals = vi.spyOn(connector, 'calculateTotals');
  const select = vi.fn<SelectMany>(successful);
  const drafts = createDraftApi(config(), connector, resolver(connector, select));
  const first = await drafts.order({ ...draft(), clientId: '202' }, context, '2026-10-08');
  expect(first.status).toBe('needs'); expect(totals).not.toHaveBeenCalled();
  const fuzzy = await drafts.order({ ...draft(), clientId: '202' }, { ...context, operatorText: 'Use the small pebble wash for the example shop', revision: 2 }, '2026-10-08');
  expect(fuzzy.status).toBe('needs'); expect(totals).not.toHaveBeenCalled();
  const spoken = 'Example Studio: 2 Pebble hand wash 250 ml. Delivery eight.';
  const next = await drafts.order(
    { ...draft(), clientId: undefined, lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }] },
    { ...context, operatorText: spoken, operatorWords: spoken, revision: 3 },
    '2026-10-08',
  );
  expect(next.status).toBe('ready');
  if (next.status === 'ready') {
    expect(next.order.client.id).toBe('201');
    expect(next.order.lines[0]?.productId).toBe('101');
    expect(next.decisions).toHaveLength(2);
  }
  expect(connector.createCalls).toBe(0);
});

it('operator button choices bypass the model but remain limited to current records', async () => {
  const connector = new DemoConnector(); const select = vi.fn(successful);
  const input = { ...draft(), lines: [{ query: 'wash', productId: '102', quantity: 2, documentPrice: { amount: 9, basis: 'net' as const, decision: 'document' as const } }] };
  const r = resolver(connector, select);
  const resolved = await r.resolve(input, { ...context, choice: { field: 'lines.0', id: '101' } });
  expect(resolved.draft.lines[0]).toMatchObject({ productId: '101', quantity: 2, documentPrice: { decision: 'pending' } });
  expect(resolved.decisions[1]?.source).toBe('operator');
  const missing = await r.resolve(input, { ...context, choice: { field: 'lines.0', id: '999999' } });
  expect(missing.issues.some(i => i.field === 'lines.0')).toBe(true);
  expect(missing.draft.lines[0]?.productId).toBeUndefined();
});

it('a tester mark on a sale SKU selects the tester catalogue product, including a free tester', async () => {
  const connector = new DemoConnector();
  const products = await connector.listProducts();
  vi.spyOn(connector, 'listProducts').mockResolvedValue([...products,
    { id: '808', code: 'SAMPLE-T', name: 'TESTER Pebble wash', description: 'Tester bottle', netPrice: 0 }]);
  const select = vi.fn(successful);
  const r = resolver(connector, select);
  const resolved = await r.resolve({
    ...draft(),
    lines: [{ query: 'DEMO-A Pebble hand wash 250 ml tester', quantity: 1, tester: true }],
  }, { ...context, operatorText: 'Create order\nDEMO-A | Pebble hand wash 250 ml | tester: 1' });
  expect(resolved.draft.lines[0]?.productId).toBe('808');
  expect(resolved.issues.filter(i => i.field === 'lines.0')).toEqual([]);
  expect(select.mock.calls.every(call => !call[0].some(req => req.kind === 'product'))).toBe(true);
});

it('does not quietly pick the sale SKU when no tester catalogue product corresponds', async () => {
  const select = vi.fn(successful);
  const resolved = await resolver(new DemoConnector(), select).resolve({
    ...draft(),
    lines: [{ query: 'DEMO-B Linen candle 200 g tester', quantity: 1, tester: true }],
  }, { ...context, operatorText: 'Create order\nDEMO-B | Linen candle 200 g | tester: 1' });
  expect(resolved.draft.lines[0]?.productId).toBeUndefined();
  expect(resolved.issues).toContainEqual(expect.objectContaining({ field: 'lines.0', matchingStatus: 'no-match' }));
  expect(select.mock.calls.every(call => !call[0].some(req => req.kind === 'product'))).toBe(true);
});

it('asks when several testers correspond and does not let the matcher assign the sale SKU', async () => {
  const connector = new DemoConnector();
  const products = await connector.listProducts();
  vi.spyOn(connector, 'listProducts').mockResolvedValue([...products,
    { id: '808', code: 'SAMPLE-T', name: 'TESTER Pebble wash 50 ml', description: '', netPrice: 4 },
    { id: '810', code: 'SAMPLE-T2', name: 'TESTER Pebble wash 100 ml', description: '', netPrice: 0 }]);
  const select = vi.fn(successful);
  const resolved = await resolver(connector, select).resolve({
    ...draft(),
    lines: [{ query: 'DEMO-A Pebble hand wash 250 ml tester', quantity: 1, tester: true }],
  }, { ...context, operatorText: 'Create order\nDEMO-A | Pebble hand wash 250 ml | tester: 1' });
  expect(resolved.draft.lines[0]?.productId).toBeUndefined();
  expect(resolved.issues).toContainEqual(expect.objectContaining({ field: 'lines.0', matchingStatus: 'ambiguous' }));
  expect(resolved.issues.find(i => i.field === 'lines.0')?.candidates?.map(c => c.id).sort()).toEqual(['808', '810']);
  expect(select.mock.calls.every(call => !call[0].some(req => req.kind === 'product'))).toBe(true);
});

it('ignores a sale-SKU operator pick on a tester line and still selects the unique tester', async () => {
  const connector = new DemoConnector();
  const products = await connector.listProducts();
  vi.spyOn(connector, 'listProducts').mockResolvedValue([...products,
    { id: '808', code: 'SAMPLE-T', name: 'TESTER Pebble wash', description: 'Tester bottle', netPrice: 4 }]);
  const select = vi.fn(successful);
  const resolved = await resolver(connector, select).resolve({
    ...draft(),
    lines: [{ query: 'DEMO-A Pebble hand wash 250 ml tester', quantity: 1, tester: true }],
  }, { ...context, operatorText: 'Create order\nDEMO-A | Pebble hand wash 250 ml | tester: 1', choice: { field: 'lines.0', id: '101' } });
  expect(resolved.draft.lines[0]?.productId).toBe('808');
  expect(resolved.decisions.find(d => d.field === 'lines.0')).toMatchObject({ source: 'exact', selectedId: '808' });
  expect(select.mock.calls.every(call => !call[0].some(req => req.kind === 'product'))).toBe(true);
});

it('an explicit code cannot silently turn into a different size or a tester', async () => {
  const connector = new DemoConnector(); const products = await connector.listProducts();
  const p = products.find(p => p.id === '101')!;
  vi.spyOn(connector, 'listProducts').mockResolvedValue([...products, { id: '991', code: 'T', name: 'TESTER Pebble wash 250 ml', description: '', netPrice: 3 }]);
  const select = vi.fn(successful);
  const r = resolver(connector, select);
  const conflict = await r.resolve(
    { ...draft(), clientId: undefined, lines: [{ query: `${p.code} 500 ml`, quantity: 2 }] },
    { ...context, operatorText: `${p.code} 500 ml`, operatorWords: `${p.code} 500 ml` },
  );
  expect(conflict.draft.lines[0]?.productId).toBeUndefined();
  expect(conflict.issues).toContainEqual(expect.objectContaining({ field: 'lines.0', matchingStatus: 'ambiguous' }));
  expect(conflict.issues.find(i => i.field === 'lines.0')?.message).toMatch(/size or variant/i);
  const denied = await r.resolve(
    { ...draft(), clientId: undefined, lines: [{ query: 'wash 250 ml, non tester', quantity: 2 }] },
    { ...context, operatorText: 'wash 250 ml, non tester', operatorWords: 'wash 250 ml, non tester' },
  );
  expect(denied.issues.find(i => i.field === 'lines.0')?.candidates?.some(c => c.id === '991')).toBe(false);
});

it('keeps explicit choices stable through quantity/price changes and invalidates changed identity data', async () => {
  const { confirmedChoices } = await import('../src/matching/resolver.js');
  const connector = new DemoConnector(); const select = vi.fn(successful); const r = resolver(connector, select);
  const first = await r.resolve({ ...draft(), lines: [{ query: 'wash', quantity: 2 }] }, { ...context, choice: { field: 'lines.0', id: '101' } });
  const choices = confirmedChoices(first.decisions);
  connector.products[0]!.netPrice = 99;
  const next = await r.resolve({ ...first.draft, lines: [{ ...first.draft.lines[0]!, quantity: 3 }] }, { ...context, revision: 2, operatorText: 'Make it three', confirmedChoices: choices });
  expect(next.draft.lines[0]).toMatchObject({ productId: '101', quantity: 3 });
  expect(next.decisions[1]?.source).toBe('operator');
  expect(select.mock.calls.some(call => call[0].some(r => r.kind === 'product'))).toBe(false);
  connector.products[0]!.name = 'Different product';
  const changed = await r.resolve(first.draft, { ...context, revision: 3, confirmedChoices: choices });
  expect(changed.draft.lines[0]?.productId).toBeUndefined();
});

it('does not calculate totals when fresh preparation data differs from the judged snapshot', async () => {
  const connector = new DemoConnector(); const products = await connector.listProducts();
  vi.spyOn(connector, 'listProducts').mockResolvedValueOnce(products).mockResolvedValue([...products, { id: '993', code: 'OTHER', name: 'Another plausible pebble wash', description: '', netPrice: 10 }]);
  const totals = vi.spyOn(connector, 'calculateTotals');
  expect((await createDraftApi(config(), connector, resolver(connector)).order(draft(), { ...context, orderId: 'freshness' }, '2026-10-08')).status).toBe('needs');
  expect(totals).not.toHaveBeenCalled();
});

it('an explicit ID disambiguates duplicate canonical product names', async () => {
  const connector = new DemoConnector(); connector.products.push({ ...connector.products[0]!, id: '994', code: 'DUPLICATE' });
  const resolved = await resolver(connector).resolve(draft(), { ...context, operatorText: 'Pebble hand wash 250 ml', choice: { field: 'lines.0', id: '994' } });
  expect(resolved.draft.lines[0]?.productId).toBe('994');
  expect(resolved.decisions[1]?.source).toBe('operator');
});

it('excludes a matching VAT record when its city contradicts the requested catalogue city', async () => {
  const connector = new DemoConnector();
  const base = connector.clients[0]!;
  connector.clients.splice(0, connector.clients.length,
    { ...base, id: '201', name: 'Rossi', city: 'Milano', vatNumber: 'IT00000000001' },
    { ...base, id: '202', name: 'Rossi', city: 'Roma', vatNumber: 'IT00000000002' });
  const select = vi.fn<SelectMany>(async requests => requests.map(r => r.candidates.length ? result('matched', r.candidates[0]!.id) : result('no-match')));
  const query = 'Rossi Milano con partita IVA IT00000000002';
  const resolved = await resolver(connector, select).resolve({ ...draft(), clientId: undefined, clientQuery: query, lines: [] }, { ...context, operatorText: query, operatorWords: query });
  expect(select.mock.calls.some(call => call[0].some(req => req.kind === 'client'))).toBe(false);
  expect(resolved.decisions[0]?.status).toBe('no-match');
  expect(resolved.draft.clientId).toBeUndefined();
});

it('lets the named customer replace a different company read from a document, like a product correction', async () => {
  const connector = new DemoConnector();
  connector.clients.push({ id: '300', name: 'Harbor Goods Srl', country: 'IT', street: 'Example Wharf 4', city: 'Example City', postalCode: '00000', vatNumber: 'IT00000000999', notes: '' });
  const selectMany = vi.fn<SelectMany>(async requests => requests.map(r => result('matched', r.kind === 'client' ? '201' : '101')));
  const harbor = { name: 'Harbor Goods Srl', country: 'IT', street: 'Example Wharf 4', city: 'Example City', postalCode: '00000', vatNumber: 'IT00000000999' };
  const input = { ...draft(), clientId: undefined, clientQuery: 'Example Studio', newClient: harbor, lines: [] };
  const resolved = await resolver(connector, selectMany).resolve(input, { ...context, operatorText: 'Order for Example Studio\n[Content read from attachments]\nHarbor Goods Srl P.IVA IT00000000999', operatorWords: 'Order for Example Studio' });
  expect(resolved.draft.clientId).toBe('201');
  expect(resolved.draft.newClient).toBeUndefined();
  const same = await resolver(connector, selectMany).resolve({ ...input, clientQuery: 'Harbor Goods' }, { ...context, operatorText: 'Order for Harbor Goods', operatorWords: 'Order for Harbor Goods' });
  expect(same.draft.newClient?.vatNumber).toBe('IT00000000999');
});

it('asks which sibling when only the everyday place name is given, and can lock the hinted hotel', async () => {
  const connector = new DemoConnector();
  const { shop, hotel, cafe } = harborSiblings();
  connector.clients.push(shop, hotel, cafe);
  const select = vi.fn<SelectMany>(async requests => requests.map(r => r.candidates.length ? result('matched', r.candidates[0]!.id) : result('no-match')));
  const r = resolver(connector, select);
  const brand = await r.resolve({ ...draft(), clientQuery: 'Fable Harbor', lines: [] }, { ...context, operatorText: 'crea ordine per fable harbor' });
  expect(brand.decisions[0]?.status).toBe('ambiguous');
  expect(brand.draft.clientId).toBeUndefined();
  expect(brand.issues[0]?.candidates?.map(c => c.id).sort()).toEqual(['210', '211', '212']);
  expect(brand.issues[0]?.candidates?.some(c => c.label.includes('hotel'))).toBe(true);
  expect(select.mock.calls.some(call => call[0].some(req => req.kind === 'client'))).toBe(false);
  const hinted = await r.resolve({ ...draft(), clientId: undefined, clientQuery: 'Fable Harbor hotel', lines: [] }, { ...context, operatorText: 'no è per l hotel', operatorWords: 'no è per l hotel' });
  expect(hinted.decisions[0]?.status).toBe('ambiguous');
  expect(hinted.draft.clientId).toBeUndefined();
  expect(hinted.issues[0]?.candidates?.map(c => c.id)).toEqual(['211']);
  const missed = await r.resolve({ ...draft(), clientQuery: 'Fable Harbor spa', lines: [] }, { ...context, operatorText: 'fable harbor spa' });
  expect(missed.decisions[0]?.status).toBe('ambiguous');
  expect(missed.issues[0]?.candidates?.map(c => c.id).sort()).toEqual(['210', '211', '212']);
});

it('asks which sibling when the everyday name lives only in notes, and a store hint still finds the shop', async () => {
  const connector = new DemoConnector();
  const { shop, hotel } = monasterySiblings();
  connector.clients.push(shop, hotel);
  const select = vi.fn<SelectMany>(async requests => requests.map(r => r.candidates.length ? result('matched', r.candidates[0]!.id) : result('no-match')));
  const r = resolver(connector, select);
  const brand = await r.resolve({ ...draft(), clientQuery: 'Harbour', lines: [] }, { ...context, operatorText: 'crea ordine per harbour' });
  expect(brand.decisions[0]?.status).toBe('ambiguous');
  expect(brand.draft.clientId).toBeUndefined();
  expect(brand.issues[0]?.candidates?.map(c => c.id).sort()).toEqual(['220', '221']);
  expect(brand.issues[0]?.candidates?.some(c => c.label.includes('Harbour Hotel'))).toBe(true);
  const hinted = await r.resolve({ ...draft(), clientId: undefined, clientQuery: 'Harbour hotel', lines: [] }, { ...context, operatorText: 'no è per l hotel', operatorWords: 'no è per l hotel' });
  expect(hinted.decisions[0]?.status).toBe('ambiguous');
  expect(hinted.draft.clientId).toBeUndefined();
  expect(hinted.issues[0]?.candidates?.map(c => c.id)).toEqual(['221']);
  const shopHint = await r.resolve({ ...draft(), clientId: undefined, clientQuery: 'Harbour negozio', lines: [] }, { ...context, operatorText: 'harbour negozio', operatorWords: 'harbour negozio' });
  expect(shopHint.decisions[0]?.status).toBe('ambiguous');
  expect(shopHint.draft.clientId).toBeUndefined();
  expect(shopHint.issues[0]?.candidates?.map(c => c.id)).toEqual(['220']);
});

it('locks a one-letter slip on a distinctive name, and does not ask which pharmacy when only the trade word matches', async () => {
  const connector = new DemoConnector();
  const { willowmere, cinderford, pebblebrook } = pharmacyTypeAccounts();
  connector.clients.push(willowmere, cinderford, pebblebrook);
  const select = vi.fn<SelectMany>(async requests => requests.map(r => r.candidates.length ? result('matched', r.candidates[0]!.id) : result('no-match')));
  const r = resolver(connector, select);
  const slipped = await r.resolve({ ...draft(), clientId: undefined, clientQuery: 'Willomere Pharmacy', lines: [] }, { ...context, operatorText: 'crea ordine per willomere pharmacy', operatorWords: 'crea ordine per willomere pharmacy' });
  expect(slipped.decisions[0]?.status).toBe('ambiguous');
  expect(slipped.draft.clientId).toBeUndefined();
  expect(slipped.issues[0]?.candidates?.map(c => c.id)).toEqual(['310']);
  select.mockClear();
  const leftover = await r.resolve({ ...draft(), clientQuery: 'Pharmacy Zorblax', lines: [] }, { ...context, operatorText: 'crea ordine per pharmacy zorblax' });
  expect(leftover.decisions[0]?.status).not.toBe('ambiguous');
  expect(leftover.issues[0]?.candidates?.map(c => c.id).sort()).not.toEqual(['310', '311', '312']);
  expect(select.mock.calls.some(call => call[0].some(req => req.kind === 'client' && req.candidates.length === 3 && req.candidates.every(c => ['310', '311', '312'].includes(c.id))))).toBe(false);
});

it('asks to confirm a leftover first name plus a distinctive business word, and does not pick a street-only account', async () => {
  const connector = new DemoConnector();
  const { agriturismo, streetOnly, east } = willowmereStayAccounts();
  connector.clients.push(agriturismo, streetOnly, east);
  const select = vi.fn<SelectMany>(async requests => requests.map(r => r.candidates.length ? result('matched', r.candidates[0]!.id) : result('no-match')));
  const r = resolver(connector, select);
  const asked = await r.resolve({ ...draft(), clientQuery: 'Giulia Willowmere', lines: [] }, { ...context, operatorText: 'crea ordine per giulia willowmere' });
  expect(asked.decisions[0]?.status).toBe('ambiguous');
  expect(asked.draft.clientId).toBeUndefined();
  expect(asked.issues[0]?.candidates?.map(c => c.id).sort()).toEqual(['410', '412']);
  expect(select.mock.calls.some(call => call[0].some(req => req.kind === 'client'))).toBe(false);
  const onlyStay = new DemoConnector();
  onlyStay.clients.push(agriturismo, streetOnly);
  const one = await resolver(onlyStay, select).resolve({ ...draft(), clientQuery: 'Giulia Willowmere', lines: [] }, { ...context, operatorText: 'crea ordine per giulia willowmere' });
  expect(one.decisions[0]?.status).toBe('ambiguous');
  expect(one.issues[0]?.candidates?.map(c => c.id)).toEqual(['410']);
});

it('asks to confirm a small extra ending on a distinctive name, prefers an exact neighbour, and still asks when two close accounts fit', async () => {
  const connector = new DemoConnector();
  const { sample, sampler, east } = sampleNameAccounts();
  connector.clients.push(sample);
  const select = vi.fn<SelectMany>(async requests => requests.map(r => r.candidates.length ? result('matched', r.candidates[0]!.id) : result('no-match')));
  const asked = await resolver(connector, select).resolve({ ...draft(), clientQuery: 'cliente sampler', lines: [] }, { ...context, operatorText: 'crea ordine per cliente sampler' });
  expect(asked.decisions[0]?.status).toBe('ambiguous');
  expect(asked.draft.clientId).toBeUndefined();
  expect(asked.issues[0]?.candidates?.map(c => c.id)).toEqual(['510']);
  expect(select.mock.calls.some(call => call[0].some(req => req.kind === 'client'))).toBe(false);
  const exact = await resolver(connector, select).resolve({ ...draft(), clientQuery: 'Cliente Sample', lines: [] }, { ...context, operatorText: 'crea ordine per Cliente Sample' });
  expect(exact.decisions[0]?.status).toBe('matched');
  expect(exact.draft.clientId).toBe('510');
  connector.clients.push(sampler, east);
  const locked = await resolver(connector, select).resolve({ ...draft(), clientQuery: 'cliente sampler', lines: [] }, { ...context, operatorText: 'crea ordine per cliente sampler' });
  expect(locked.decisions[0]?.status).toBe('matched');
  expect(locked.draft.clientId).toBe('511');
  const two = new DemoConnector();
  two.clients.push(sample, east);
  const choice = await resolver(two, select).resolve({ ...draft(), clientQuery: 'cliente sampler', lines: [] }, { ...context, operatorText: 'crea ordine per cliente sampler' });
  expect(choice.decisions[0]?.status).toBe('ambiguous');
  expect(choice.issues[0]?.candidates?.map(c => c.id).sort()).toEqual(['510', '512']);
});

it('reads catalogue litres written as "5lt" so a "5 L" request keeps them as candidates', async () => {
  const connector = new DemoConnector();
  connector.products.push({ id: '500', code: 'DEMO-5L', name: 'Cedar wash 5lt', description: '', netPrice: 18 },
    { id: '501', code: 'DEMO-500', name: 'Cedar wash 500ml', description: '', netPrice: 8 });
  const selectMany = vi.fn<SelectMany>(async requests => requests.map(r => result('matched', r.kind === 'client' ? '201' : '500')));
  const resolved = await resolver(connector, selectMany).resolve(
    { ...draft(), clientId: undefined, lines: [{ query: 'Refill 5 L Cedar wash', quantity: 1 }] },
    { ...context, operatorText: 'Refill 5 L Cedar wash', operatorWords: 'Refill 5 L Cedar wash' },
  );
  expect(resolved.draft.lines[0]?.productId).toBeUndefined();
  expect(resolved.issues.find(i => i.field === 'lines.0')?.candidates?.map(c => c.id)).toEqual(['500']);
});
