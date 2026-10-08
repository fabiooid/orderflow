import { createJevBatchSelector } from '../src/matching/jev-client.js';
import { expect, it, vi } from 'vitest';
import { withCompleteClientSearch, MAX_CLIENT_SEARCH } from '../src/matching/client-search.js';
import { createIdentityResolver } from '../src/matching/resolver.js';
import { matchingConfigSchema } from '../src/matching/config.js';
import { DemoConnector } from '../src/connector/demo.js';
import type { SelectionRequest, SelectionResult } from '../src/matching/types.js';
import { config, draft } from './helpers.js';

const request = (count = 600): SelectionRequest => ({ kind: 'client', query: 'Rossy', context: 'Order for Rossy',
  candidates: Array.from({ length: count }, (_, i) => ({ id: i + 1, name: i === 599 ? 'Rossi Commercio' : `Customer ${i + 1}` })),
  retrieval: { complete: true, furtherSearchPossible: false } });
const answer = (status: SelectionResult['status'], selectedId?: number): SelectionResult => ({ status, selectedId,
  evidence: { requestHash: 'fixture', promptVersion: 'fixture', retrieval: { complete: true, furtherSearchPossible: false }, elapsedMs: 1 } });

it('covers all 600 customers in one batch, preserves the original name, and accepts a match in the last group', async () => {
  const select = vi.fn(async (groups: SelectionRequest[]) => groups.map(g => g.candidates.some(c => c.id === 600) ? answer('matched', 600) : answer('no-match')));
  const [result] = await withCompleteClientSearch(select)([request()]);
  expect(select).toHaveBeenCalledTimes(1);
  const groups = select.mock.calls[0]![0];
  expect(groups.map(g => g.candidates.length)).toEqual([253, 253, 94]);
  expect(groups.flatMap(g => g.candidates.map(c => c.id))).toEqual(request().candidates.map(c => c.id));
  expect(groups.every(g => g.query === 'Rossy' && g.context === 'Order for Rossy')).toBe(true);
  expect(result).toMatchObject({ status: 'matched', selectedId: 600 });
  expect(result?.evidence.groups).toHaveLength(3);
  expect(result?.evidence.confidence).toBeUndefined();
});

it.each([
  [['matched', 'no-match', 'matched'], 'ambiguous'],
  [['matched', 'ambiguous', 'no-match'], 'ambiguous'],
  [['matched', 'unavailable', 'no-match'], 'unavailable'],
  [['no-match', 'no-match', 'no-match'], 'no-match'],
] as const)('combines group statuses %j conservatively', async (statuses, expected) => {
  const [result] = await withCompleteClientSearch(async groups => groups.map((g, i) => answer(statuses[i]!, g.candidates[0]!.id)))([request()]);
  expect(result?.status).toBe(expected);
  expect(result?.selectedId).toBeUndefined();
});

it('rejects invented IDs and missing group results instead of accepting another group match', async () => {
  for (const parts of [[answer('matched', 9999), answer('no-match'), answer('no-match')], [answer('matched', 1)]]) {
    expect((await withCompleteClientSearch(async () => parts)([request()]))[0]?.status).toBe('unavailable');
  }
});

it('does not search incomplete, invalid, duplicate, or over-budget customer sets', async () => {
  const duplicate = request(); duplicate.candidates[599] = duplicate.candidates[0]!;
  const invalid = request(); invalid.candidates[599]!.name = '';
  const select = vi.fn(async () => []);
  for (const input of [duplicate, invalid, request(MAX_CLIENT_SEARCH + 1), { ...request(), retrieval: { complete: false, furtherSearchPossible: true } }]) {
    expect((await withCompleteClientSearch(select)([input]))[0]?.status).toBe('unavailable');
  }
  expect(select).not.toHaveBeenCalled();
});

it('keeps product and small-customer requests alongside grouped customers in the original result order', async () => {
  const small = request(2), product = { ...small, kind: 'product' as const };
  const results = await withCompleteClientSearch(async groups => groups.map(g => g.kind === 'product' ? answer('matched', 1) : answer('no-match')))([small, request(), product]);
  expect(results.map(r => r.status)).toEqual(['no-match', 'no-match', 'matched']);
  expect(results[2]?.selectedId).toBe(1);
});

it.each(['on', 'shadow'] as const)('uses complete customer search in the shared resolver in %s mode', async mode => {
  const connector = new DemoConnector(); const base = connector.clients[0]!;
  connector.clients.splice(0, connector.clients.length, ...request().candidates.map(c => ({ ...base, ...c })));
  const resolver = createIdentityResolver(config(), connector, { config: matchingConfigSchema.parse({ mode }),
    selectMany: async groups => groups.map(g => g.candidates.some(c => c.id === 600) ? answer('matched', 600) : answer('no-match')) });
  const input = { ...draft(), clientQuery: 'Rossy', lines: [] };
  const result = await resolver.resolve(input, { orderId: 'large-client-test', revision: 1, operatorText: 'Rossy' });
  expect(result.issues).toEqual([]);
  expect(result.decisions[0]).toMatchObject({ status: 'matched', selectedId: 600 });
  expect(result.decisions[0]?.searchGroups).toHaveLength(3);
  if (mode === 'on') expect(result.draft.clientId).toBe(600);
  else expect(result.draft).toEqual(input);
});


it('sends all three customer groups through the real batch adapter in one transport call', async () => {
  const transport = vi.fn(async (input: any) => ({ model: 'test-model', usage: { input_tokens: 10, output_tokens: 10 },
    answers: Object.fromEntries(Object.entries(input.questions).map(([key, question]: [string, any]) => {
      const chosen = Object.entries(question.criteria).find(([, value]: [string, any]) => value.id === 600)?.[0] ?? 'no_match';
      return [key, { type: 'choice', choice: chosen, confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(option => [option, Number(option === chosen)])) }];
    })) }));
  const select = withCompleteClientSearch(createJevBatchSelector(matchingConfigSchema.parse({ mode: 'on' }), transport));
  expect((await select([request()]))[0]).toMatchObject({ status: 'matched', selectedId: 600 });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(Object.keys(transport.mock.calls[0]![0].questions)).toHaveLength(3);
});
