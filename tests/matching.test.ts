import { describe, expect, it, vi } from 'vitest';
import { matchingConfigSchema, loadMatchingConfig } from '../src/matching/config.js';
import { createJevSelector, sdkTransport } from '../src/matching/jev-client.js';
import { matchingFixtures } from '../src/matching/fixtures.js';
import { productCandidates, clientCandidates } from '../src/matching/candidates.js';

const config = matchingConfigSchema.parse({ mode: 'shadow', maxRetries: 0 });
const request = matchingFixtures[0]!.request;
const response = (selected = 'candidate_1') => ({ model: 'jev-1.13.0',
  usage: { input_tokens: 10, output_tokens: 10 },
  answers: { selection: { type: 'choice', choice: selected, confidence: 1,
    probabilities: Object.fromEntries(['candidate_0', 'candidate_1', 'candidate_2', 'candidate_3', 'ambiguous', 'no_match'].map(k => [k, Number(k === selected)])) } } });

describe('read-only JEV selection boundary', () => {
  it('maps the validated candidate key to the supplied record ID', async () => {
    const transport = vi.fn().mockResolvedValue(response());
    const result = await createJevSelector(config, transport)(request);
    expect(result).toMatchObject({ status: 'matched', selectedId: 102, evidence: { model: 'jev-1.13.0' } });
    expect(result.evidence.requestHash).toHaveLength(64);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(['ambiguous', 'no_match'])('preserves %s without an ID', async selected => {
    const result = await createJevSelector(config, async () => response(selected))(request);
    expect(result.status).toBe(selected === 'no_match' ? 'no-match' : selected);
    expect(result.selectedId).toBeUndefined();
  });
  it('rejects invented keys and malformed distributions', async () => {
    for (const raw of [response('invented'), { ...response(), answers: {} },
      { ...response(), answers: { selection: { ...response().answers.selection, probabilities: { candidate_1: 1 } } } }]) {
      expect(await createJevSelector(config, async () => raw)(request)).toMatchObject({ status: 'unavailable', reason: 'invalid-response' });
    }
  });
  it('accepts 2-decimal rounding drift but rejects distributions that do not sum to 1', async () => {
    const withProbabilities = (probabilities: Record<string, number>) => ({ ...response('no_match'),
      answers: { selection: { ...response('no_match').answers.selection, confidence: 0.66, probabilities } } });
    // Observed live: rounded probabilities summing to 0.99 (0.98999… in floating point).
    const rounded = { candidate_0: 0.11, candidate_1: 0.11, candidate_2: 0.11, candidate_3: 0, ambiguous: 0, no_match: 0.66 };
    expect((await createJevSelector(config, async () => withProbabilities(rounded))(request)).status).toBe('no-match');
    const skewed = { candidate_0: 0.05, candidate_1: 0.05, candidate_2: 0, candidate_3: 0, ambiguous: 0, no_match: 0.66 };
    expect(await createJevSelector(config, async () => withProbabilities(skewed))(request)).toMatchObject({ status: 'unavailable', reason: 'invalid-response' });
  });
  it('does not call the service for incomplete, oversized or duplicate candidate sets', async () => {
    const transport = vi.fn();
    const select = createJevSelector(config, transport);
    expect((await select({ ...request, retrieval: { complete: false, furtherSearchPossible: true } })).reason).toBe('incomplete-retrieval');
    expect((await select({ ...request, candidates: Array.from({ length: 254 }, (_, i) => ({ id: i + 1, name: 'test' })) })).reason).toBe('invalid-input');
    expect((await select({ ...request, candidates: [request.candidates[0]!, request.candidates[0]!] })).reason).toBe('invalid-input');
    expect(transport).not.toHaveBeenCalled();
  });
  it('redacts transport errors and changes evidence when the query changes', async () => {
    const select = createJevSelector(config, async () => { throw new Error('secret-token private client'); });
    const first = await select(request);
    expect(JSON.stringify(first)).not.toContain('secret-token');
    expect(first.reason).toBe('service-unavailable');
    expect((await select({ ...request, query: 'different' })).evidence.requestHash).not.toBe(first.evidence.requestHash);
  });
  it('keeps off mode inert and checks enabled credentials', async () => {
    expect(loadMatchingConfig({}).mode).toBe('off');
    expect(() => loadMatchingConfig({ JEV_MODE: 'shadow' })).toThrow('TYPESAFE_API_KEY');
    expect((await createJevSelector(matchingConfigSchema.parse({}))(request)).reason).toBe('disabled');
  });
  it('uses the official SDK wire format without live network access', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(config.model);
      expect(body.questions.selection.type).toBe('choice');
      return new Response(JSON.stringify(response()), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const result = await createJevSelector(config, sdkTransport(config, 'fictional-key', fetch))(request);
    expect(result.status).toBe('matched');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('projects identity fields and excludes shipping and zero-priced description items', () => {
    const products = [{ id: 1, code: 'A', name: 'Soap', description: '', netPrice: 5 },
      { id: 2, code: 'B', name: 'Delivery', description: '', netPrice: 15 },
      { id: 3, code: 'C', name: 'Heading', description: '', netPrice: 0 }];
    expect(productCandidates(products, 2)).toEqual([{ id: 1, code: 'A', name: 'Soap', description: '' }]);
    expect(clientCandidates([{ id: 1, name: 'Shop', country: 'IT', city: 'Roma', street: 'private', postalCode: '00100', notes: 'private' }]))
      .toEqual([{ id: 1, name: 'Shop', country: 'IT', city: 'Roma' }]);
  });
  it('bounds SDK retries and does not retry authentication failures', async () => {
    for (const status of [401, 503]) {
      const fetch = vi.fn(async () => new Response('private service error', { status }));
      const retryConfig = { ...config, maxRetries: 1 };
      const result = await createJevSelector(retryConfig, sdkTransport(retryConfig, 'fictional-key', fetch))(request);
      expect(result.reason).toBe('service-unavailable');
      expect(fetch).toHaveBeenCalledTimes(status === 401 ? 1 : 2);
      expect(JSON.stringify(result)).not.toContain('private service error');
    }
  });
  it('propagates caller cancellation without a successful selection', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn(async () => new Response(JSON.stringify(response())));
    const result = await createJevSelector(config, sdkTransport(config, 'fictional-key', fetch))(request, controller.signal);
    expect(result.status).toBe('unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });
});
