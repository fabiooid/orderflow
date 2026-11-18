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
const readySpoken = 'Example Studio: 2 Pebble hand wash 250 ml. Delivery eight.';
const readyContext = { ...context, operatorText: readySpoken, operatorWords: readySpoken };

it('reports a ready order with its totals, or exactly what is still needed', async () => {
  const api = createDraftApi(config(), new DemoConnector(), off);
  const ready = await api.order(draft(), readyContext, '2026-01-15');
  expect(ready.status).toBe('ready');
  if (ready.status === 'ready') expect(ready.totals.gross).toBe(36.11);
  const needsSpoken = 'Example Studio: 2 Pebble 250';
  const needs = await api.order({ ...draft(), lines: [{ query: 'Pebble 250', quantity: 2 }], shippingPrice: undefined }, { ...context, operatorText: needsSpoken, operatorWords: needsSpoken }, '2026-01-15');
  expect(needs.status).toBe('needs');
  if (needs.status !== 'needs') return;
  expect(needs.issues[0]).toMatchObject({ field: 'lines.0', candidates: expect.arrayContaining([expect.objectContaining({ id: '101' })]) });
  // The agent reads the problems and candidate names; record IDs stay with the application.
  expect(forAgent(needs)).toMatchObject({
    status: 'needs',
    customer: { status: 'accepted', name: 'Example Studio' },
    lines: [{ query: 'Pebble 250', quantity: 2, status: expect.stringMatching(/unconfirmed|ambiguous|unsupported/) }],
    issues: [{ field: 'lines.0', candidates: expect.arrayContaining([expect.stringMatching(/Pebble hand wash 250 ml/)]) }],
  });
  expect(JSON.stringify(forAgent(needs))).not.toContain('101');
});

it('rereads a tester mark so a later turn cannot treat it as the sale SKU', async () => {
  const api = createDraftApi(config(), new DemoConnector(), off);
  const needs = await api.order(draftSchema.parse({
    clientQuery: 'Example Studio',
    lines: [
      { query: 'SOAP250ML Pebble hand wash 250 ml', quantity: 2 },
      { query: 'SOAP250ML Pebble hand wash 250 ml tester', quantity: 1, tester: true },
    ],
  }), context, '2026-01-15');
  expect(needs.status).toBe('needs');
  expect(forAgent(needs).lines).toEqual(expect.arrayContaining([
    expect.objectContaining({ query: expect.stringMatching(/SOAP250ML/), quantity: 2, status: expect.stringMatching(/unconfirmed|ambiguous|unsupported|missing/) }),
    expect.objectContaining({ query: expect.stringMatching(/tester/i), quantity: 1, tester: true, status: expect.stringMatching(/unconfirmed|ambiguous|unsupported|missing/) }),
  ]));
});

it('shows an unmatched customer query so the agent cannot contradict the preview', async () => {
  const api = createDraftApi(config(), new DemoConnector(), off);
  const spoken = 'Northwind Supplies Ltd: 2 Pebble hand wash 250 ml';
  const needs = await api.order(draftSchema.parse({
    clientQuery: 'Northwind Supplies Ltd',
    lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }],
  }), { ...context, operatorText: spoken, operatorWords: spoken }, '2026-01-15');
  expect(needs.status).toBe('needs');
  expect(forAgent(needs)).toMatchObject({
    status: 'needs',
    customer: { status: expect.stringMatching(/unconfirmed|ambiguous|unsupported|missing/), query: 'Northwind Supplies Ltd' },
    lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2, status: 'accepted' }],
  });
  expect(JSON.stringify(forAgent(needs))).not.toContain('"status":"accepted","name"');
});

it('never trusts a model-written identity: matcher proposals stay unconfirmed until an exact identity or pick', async () => {
  const judge: SelectMany = async requests => requests.map(r => ({ status: 'matched', selectedId: r.kind === 'client' ? '201' : '101', evidence: { requestHash: 't', promptVersion: 't', retrieval: r.retrieval, elapsedMs: 0 } } satisfies SelectionResult));
  const connector = new DemoConnector();
  const on = createIdentityResolver(config(), connector, { config: matchingConfigSchema.parse({ mode: 'on' }), selectMany: judge });
  const spoken = 'the small pebble wash for the studio';
  const result = await createDraftApi(config(), connector, on).order({ ...draft(), clientId: '999', lines: [{ query: 'the small pebble wash', productId: '102', quantity: 2 }] }, { ...context, operatorText: spoken, operatorWords: spoken }, '2026-01-15');
  expect(result.status).toBe('needs');
  expect(result.draft.clientId).toBeUndefined();
  expect(result.draft.lines[0]?.productId).toBeUndefined();
  if (result.status === 'needs') expect(result.issues.some(i => i.field === 'client' && i.candidates?.length)).toBe(true);
  // An operator's button pick is the one identity that comes from outside the resolver.
  const picked = await createDraftApi(config(), connector, on).order(result.draft, { ...context, operatorText: spoken, operatorWords: spoken, choice: { field: 'lines.0', id: '101' } }, '2026-01-15');
  expect(picked.draft.lines[0]?.productId).toBe('101');
});

it('drafts a new customer and lists the deployment\'s missing fields', async () => {
  const api = createDraftApi(config(), new DemoConnector(), off);
  const result = await api.customer(draftSchema.parse({ newClient: { name: 'Fable Goods' } }), context);
  expect(result).toMatchObject({ kind: 'customer', status: 'needs', draft: { newClient: { name: 'Fable Goods' } } });
  if (result.status === 'needs') expect(result.issues.map(i => i.field)).toEqual(['client.email', 'client.vatNumber']);
  const ready = await api.customer(draftSchema.parse({ newClient: { name: 'Fable Goods', email: 'info@fable.invalid', vatNumber: 'IT1' } }), context);
  expect(ready.status).toBe('ready');
});

it('does not open an empty order card when prepare is called with no customer and no products', async () => {
  const storage = new LibSQLStore({ id: 'empty-order', url: ':memory:' });
  try {
    const { calls } = createOrderAgent(config(), new DemoConnector(), storage);
    const context = new RequestContext();
    const outcome = startTurn(context, { evidence: 'crea un nuovo ordine per Northwind Bistro', operatorWords: 'crea un nuovo ordine per Northwind Bistro', senderId: '5', knownPhrases: [] });
    expect(await calls.order(draftSchema.parse({}), context)).toMatchObject({
      status: 'needs',
      issues: [{ field: 'client', problem: expect.stringContaining('Name a customer') }],
      note: expect.stringContaining('Nothing was shown'),
    });
    expect(outcome.result).toBeUndefined();
    // A named customer still prepares: the application can lock it and ask for products.
    const named = new RequestContext();
    const locked = startTurn(named, { evidence: 'crea un nuovo ordine per Example Studio', operatorWords: 'crea un nuovo ordine per Example Studio', senderId: '5', knownPhrases: [] });
    const result = await calls.order(draftSchema.parse({ clientQuery: 'Example Studio' }), named);
    expect(result).toMatchObject({ status: 'needs' });
    expect(result.status === 'needs' && result.issues?.some(i => i.field === 'lines' || i.field.startsWith('lines.'))).toBe(true);
    expect(locked.result).toMatchObject({ kind: 'order', client: expect.objectContaining({ id: '201', name: 'Example Studio' }) });
    // Product lines without a customer still prepare, so a short follow-up like "add 20" can open a draft.
    const products = new RequestContext();
    const followUp = startTurn(products, { evidence: 'add 20 to a new order', operatorWords: 'add 20 to a new order', senderId: '5', knownPhrases: [] });
    expect(await calls.order(draftSchema.parse({ lines: [{ query: 'Linen candle 200 g', quantity: 20 }] }), products)).toMatchObject({ status: 'needs' });
    expect(followUp.result).toMatchObject({ kind: 'order', draft: expect.objectContaining({ lines: [expect.objectContaining({ query: 'Linen candle 200 g', quantity: 20 })] }) });
  } finally { await storage.close(); }
});

it('keeps this request\'s customer when a later draft only adds product lines', async () => {
  const storage = new LibSQLStore({ id: 'keep-customer', url: ':memory:' });
  try {
    const { calls } = createOrderAgent(config(), new DemoConnector(), storage);
    const context = new RequestContext();
    const outcome = startTurn(context, {
      evidence: 'cliente Example Studio', operatorWords: 'cliente Example Studio', senderId: '5', knownPhrases: ['Example Studio'],
      request: { kind: 'order', orderId: 'u1', revision: 1, draft: draftSchema.parse({ clientQuery: 'Example Studio', clientId: '201' }) },
    });
    const result = await calls.order(draftSchema.parse({
      lines: [
        { query: 'Hand cream 100 ml SKU-100', quantity: 2 },
        { query: 'Room spray 250 ml SKU-250 tester', quantity: 1, tester: true },
      ],
    }), context);
    expect(result.status).toBe('needs');
    expect(outcome.result).toMatchObject({
      kind: 'order',
      draft: {
        clientQuery: 'Example Studio',
        clientId: '201',
        lines: [
          expect.objectContaining({ query: 'Hand cream 100 ml SKU-100', quantity: 2 }),
          expect.objectContaining({ query: 'Room spray 250 ml SKU-250 tester', quantity: 1, tester: true }),
        ],
      },
    });
  } finally { await storage.close(); }
});

it('keeps this request\'s product lines when a later draft only locks the customer', async () => {
  const storage = new LibSQLStore({ id: 'keep-lines', url: ':memory:' });
  try {
    const { calls } = createOrderAgent(config(), new DemoConnector(), storage);
    const lines = [{ query: 'Pebble hand wash 250 ml', quantity: 2 }, { query: 'Linen candle 200 g', quantity: 1 }];
    const context = new RequestContext();
    const outcome = startTurn(context, {
      evidence: 'cliente Northwind Bistro', operatorWords: 'cliente Northwind Bistro', senderId: '5', knownPhrases: ['Pebble hand wash 250 ml'],
      request: { kind: 'order', orderId: 'u1', revision: 1, draft: draftSchema.parse({ lines }) },
    });
    const result = await calls.order(draftSchema.parse({ clientQuery: 'Northwind Bistro' }), context);
    expect(result).toMatchObject({ status: 'needs' });
    expect(result.status === 'needs' && result.issues?.some(i => i.field === 'lines')).toBe(false);
    expect(outcome.result).toMatchObject({
      kind: 'order',
      draft: { lines: [expect.objectContaining({ query: 'Pebble hand wash 250 ml', quantity: 2 }), expect.objectContaining({ query: 'Linen candle 200 g', quantity: 1 })] },
    });
  } finally { await storage.close(); }
});

it('does not copy leftover lines onto a new request that only names a customer', async () => {
  const storage = new LibSQLStore({ id: 'no-invent-lines', url: ':memory:' });
  try {
    const { calls } = createOrderAgent(config(), new DemoConnector(), storage);
    const context = new RequestContext();
    const outcome = startTurn(context, { evidence: 'crea un nuovo ordine per Northwind Bistro', operatorWords: 'crea un nuovo ordine per Northwind Bistro', senderId: '5', knownPhrases: [] });
    const result = await calls.order(draftSchema.parse({ clientQuery: 'Northwind Bistro' }), context);
    expect(result).toMatchObject({ status: 'needs' });
    expect(result.status === 'needs' && result.issues?.some(i => i.field === 'lines')).toBe(true);
    expect(outcome.result).toMatchObject({ kind: 'order', draft: { lines: [] } });
  } finally { await storage.close(); }
});

it('replaces an open request of the other kind, and is blocked only by a request the turn cannot change', async () => {
  const storage = new LibSQLStore({ id: 'tools', url: ':memory:' });
  try {
    const { calls } = createOrderAgent(config(), new DemoConnector(), storage);
    const turn = { evidence: 'Example Studio: 2 Pebble hand wash 250 ml, delivery 8', operatorWords: 'Example Studio: 2 Pebble hand wash 250 ml, delivery 8', senderId: '5', knownPhrases: [] };
    const replacing = new RequestContext();
    const replaced = startTurn(replacing, { ...turn, request: { kind: 'customer', orderId: 'u1', revision: 1, draft: draftSchema.parse({ newClient: { name: 'Other' } }) } });
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
    const resourceId = `${c.deploymentId}:telegram:${c.channel.groupId}`;
    await memory.createThread({ threadId: 'one', resourceId });
    await memory.createThread({ threadId: 'two', resourceId });
    const confirmed = sharedKnowledgeSchema.parse({ aliases: [{ phrase: 'small wash', productId: '101', sourceMessage: 'demo-message', confirmedBy: 'demo-operator' }] });
    await memory.updateWorkingMemory({ threadId: 'one', resourceId, workingMemory: JSON.stringify(confirmed) });
    expect(await memory.getWorkingMemory({ threadId: 'two', resourceId })).toContain('small wash');
    expect(() => sharedKnowledgeSchema.parse({ ...confirmed, prices: { item: 1 } })).toThrow();
  } finally { await storage.close(); }
}, 20000);
