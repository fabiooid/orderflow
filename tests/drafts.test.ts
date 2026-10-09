import { LibSQLStore } from '@mastra/libsql';
import { RequestContext } from '@mastra/core/request-context';
import { expect, it } from 'vitest';
import { createOrderAgent, sharedKnowledgeSchema } from '../src/assistant/agent.js';
import { startTurn } from '../src/assistant/turn-context.js';
import { createDraftApi, forAgent } from '../src/assistant/drafts.js';
import { DemoConnector } from '../src/connector/demo.js';
import { draftSchema } from '../src/domain/types.js';
import { createIdentityResolver, type SelectMany } from '../src/matching/resolver.js';
import { matchingConfigSchema } from '../src/matching/config.js';
import type { SelectionResult } from '../src/matching/types.js';
import { config, draft } from './helpers.js';

const off = createIdentityResolver(config(), new DemoConnector(), { config: matchingConfigSchema.parse({ mode: 'off' }) });
const context = { orderId: 'test', revision: 1, operatorText: '' };

it('reports a ready order with its totals, or exactly what is still needed', async () => {
  const api = createDraftApi(config(), new DemoConnector(), off);
  const ready = await api.order(draft(), context, '2026-01-15');
  expect(ready.status).toBe('ready');
  if (ready.status === 'ready') expect(ready.totals.gross).toBe(36.11);
  const needs = await api.order({ ...draft(), lines: [{ query: 'Amber 250', quantity: 2 }], shippingPrice: undefined }, context, '2026-01-15');
  expect(needs.status).toBe('needs');
  if (needs.status !== 'needs') return;
  expect(needs.issues[0]).toMatchObject({ field: 'lines.0', candidates: expect.arrayContaining([expect.objectContaining({ id: 101 })]) });
  // The agent reads the problems and candidate names; record IDs stay with the application.
  expect(forAgent(needs)).toMatchObject({ status: 'needs', issues: [{ field: 'lines.0', candidates: expect.arrayContaining(['Amber hand wash 250 ml']) }] });
  expect(JSON.stringify(forAgent(needs))).not.toContain('101');
});

it('never trusts a model-written identity: matching replaces it with the judged one', async () => {
  const judge: SelectMany = async requests => requests.map(r => ({ status: 'matched', selectedId: r.kind === 'client' ? 201 : 101, evidence: { requestHash: 't', promptVersion: 't', retrieval: r.retrieval, elapsedMs: 0 } } satisfies SelectionResult));
  const connector = new DemoConnector();
  const on = createIdentityResolver(config(), connector, { config: matchingConfigSchema.parse({ mode: 'on' }), selectMany: judge });
  const result = await createDraftApi(config(), connector, on).order({ ...draft(), clientId: 999, lines: [{ query: 'the small amber wash', productId: 102, quantity: 2 }] }, { ...context, operatorText: 'the small amber wash for the studio' }, '2026-01-15');
  expect(result.status).toBe('ready');
  expect(result.draft.clientId).toBe(201);
  expect(result.draft.lines[0]?.productId).toBe(101);
  // An operator's button pick is the one identity that comes from outside the resolver.
  const picked = await createDraftApi(config(), connector, on).order(result.draft, { ...context, choice: { field: 'lines.0', id: 102 } }, '2026-01-15');
  expect(picked.draft.lines[0]?.productId).toBe(102);
});

it('drafts a new customer and lists the deployment\'s missing fields', async () => {
  const api = createDraftApi(config(), new DemoConnector(), off);
  const result = await api.customer(draftSchema.parse({ newClient: { name: 'Bottega Verde' } }), context);
  expect(result).toMatchObject({ kind: 'customer', status: 'needs', draft: { newClient: { name: 'Bottega Verde' } } });
  if (result.status === 'needs') expect(result.issues.map(i => i.field)).toEqual(['client.email', 'client.vatNumber']);
  const ready = await api.customer(draftSchema.parse({ newClient: { name: 'Bottega Verde', email: 'info@bottega.invalid', vatNumber: 'IT1' } }), context);
  expect(ready.status).toBe('ready');
});

it('replaces an open request of the other kind, and is blocked only by a request the turn cannot change', async () => {
  const storage = new LibSQLStore({ id: 'tools', url: ':memory:' });
  try {
    const { calls } = createOrderAgent(config(), new DemoConnector(), storage);
    const turn = { evidence: '', operatorWords: '', senderId: '5', knownPhrases: [] };
    const replacing = new RequestContext();
    const replaced = startTurn(replacing, { ...turn, request: { kind: 'customer', orderId: 'u1', revision: 1 } });
    expect(await calls.order(draft(), replacing)).toMatchObject({ status: 'ready' });
    expect(replaced.result).toMatchObject({ kind: 'order' });
    const locked = new RequestContext();
    const refused = startTurn(locked, { ...turn, locked: 'Ordine — salvataggio da verificare' });
    expect(await calls.customer(draftSchema.parse({ newClient: { name: 'Other' } }), locked)).toMatchObject({ status: 'blocked' });
    expect(refused).toEqual({ refused: true });
    // Cancelling reports the real outcome: a locked request cannot be cancelled here.
    expect(calls.cancel(locked)).toMatchObject({ status: 'locked' });
  } finally { await storage.close(); }
}, 20000);

it('uses Mastra resource memory for shared confirmed aliases without storing prices', async () => {
  const storage = new LibSQLStore({ id: 'memory', url: ':memory:' });
  try {
    const c = config();
    const { memory } = createOrderAgent(c, new DemoConnector(), storage);
    const resourceId = `${c.deploymentId}:telegram:${c.telegram.groupId}`;
    await memory.createThread({ threadId: 'one', resourceId });
    await memory.createThread({ threadId: 'two', resourceId });
    const confirmed = sharedKnowledgeSchema.parse({ aliases: [{ phrase: 'small wash', productId: 101, sourceMessage: 'demo-message', confirmedBy: 'demo-operator' }] });
    await memory.updateWorkingMemory({ threadId: 'one', resourceId, workingMemory: JSON.stringify(confirmed) });
    expect(await memory.getWorkingMemory({ threadId: 'two', resourceId })).toContain('small wash');
    expect(() => sharedKnowledgeSchema.parse({ ...confirmed, prices: { item: 1 } })).toThrow();
  } finally { await storage.close(); }
}, 20000);
