import { expect, it } from 'vitest';
import { LibSQLStore } from '@mastra/libsql';
import { RequestContext } from '@mastra/core/request-context';
import { createOrderAgent } from '../src/assistant/agent.js';
import { draftOutput } from '../src/assistant/draft-schema.js';
import { forAgent } from '../src/assistant/drafts.js';
import { ensureLineRefs, mergeOrderDraft } from '../src/assistant/merge.js';
import { startTurn } from '../src/assistant/turn-context.js';
import { DemoConnector } from '../src/connector/demo.js';
import { draftSchema } from '../src/domain/types.js';
import { loadConversation } from '../src/channel/store.js';
import { orderCreator } from '../src/channel/order.js';
import { policyFingerprint } from '../src/channel/controller.js';
import { WriteJournal } from '../src/storage/write-journal.js';
import { createDraftApi } from '../src/assistant/drafts.js';
import { createIdentityResolver, type SelectMany } from '../src/matching/resolver.js';
import { matchingConfigSchema } from '../src/matching/config.js';
import type { SelectionResult } from '../src/matching/types.js';
import { runConversation, scriptedTurns } from '../src/evals/harness.js';
import { maplePine } from '../src/evals/conversations.js';
import { complete, config, draft, prepared } from './helpers.js';

const onConfig = matchingConfigSchema.parse({ mode: 'on' });
const judge: SelectMany = async requests => requests.map(r => ({
  status: 'matched', selectedId: r.candidates[0]?.id, evidence: { requestHash: 't', promptVersion: 't', retrieval: r.retrieval, elapsedMs: 1, model: 'test-model' },
} satisfies SelectionResult));
const noMatch: SelectMany = async requests => requests.map(r => ({
  status: 'no-match', evidence: { requestHash: 't', promptVersion: 't', retrieval: r.retrieval, elapsedMs: 1 },
} satisfies SelectionResult));

function api(connector = new DemoConnector(), selectMany: SelectMany = judge) {
  return createDraftApi(config(), connector, createIdentityResolver(config(), connector, { config: onConfig, selectMany }));
}

it('exposes identity states, candidates, actions, line refs and revision through the declared prepare-order schema', async () => {
  const storage = new LibSQLStore({ id: 'tool-schema', url: ':memory:' });
  try {
    const { agent } = createOrderAgent(config(), new DemoConnector(), storage, { enabled: false, rate: 0 }, { config: onConfig, selectMany: judge });
    const tools = await agent.listTools();
    const context = new RequestContext();
    startTurn(context, { evidence: 'ordine per Maple: pebble wash', operatorWords: 'ordine per Maple: pebble wash', senderId: '5', knownPhrases: [] });
    const raw = await tools.prepareOrder!.execute!({
      clientQuery: 'Maple', clientId: null, newClient: null, manualVatCheck: null,
      lines: [{ ref: null, op: null, query: 'pebble wash', productId: null, quantity: 2, tester: null, netPrice: null, documentPrice: null }],
      shippingPrice: null, discountPercent: 0, discountShipping: null, delivery: null, notes: '', priceTier: null,
    }, { requestContext: context } as never);
    const parsed = draftOutput.parse(raw);
    expect(parsed.status).toBe('needs');
    expect(parsed.revision).toBe(1);
    expect(parsed.customer?.status).toMatch(/unconfirmed|ambiguous|unsupported|missing/);
    expect(parsed.customer?.status).not.toBe('accepted');
    expect(parsed.lines?.[0]?.ref).toMatch(/^L\d+$/);
    expect(parsed.lines?.[0]?.status).not.toBe('accepted');
    expect(parsed.note).toMatch(/never say the draft is ready while status is needs/i);
    expect(JSON.stringify(parsed)).not.toMatch(/secret|password|token/i);
  } finally { await storage.close(); }
});

it('keeps one canonical merge: no duplicate rows, sale+tester stay two lines, repeated attachment is not a second set', () => {
  const sale = { query: 'DEMO-A Pebble hand wash 250 ml', quantity: 2 };
  const tester = { query: 'DEMO-A Pebble hand wash 250 ml tester', quantity: 1, tester: true as const };
  const first = mergeOrderDraft({
    incoming: draftSchema.parse({ lines: [sale, tester] }),
    attachmentLines: [sale, tester],
    operatorWords: 'prepara questo file',
    attachmentText: 'DEMO-A | kit 30ml 50ml | Qty 2\nDEMO-A tester | Qty 1',
    isNewRequest: true,
  });
  expect(first.lines).toHaveLength(2);
  expect(first.lines.map(l => l.ref)).toEqual(['L1', 'L2']);
  const repeated = mergeOrderDraft({
    base: first,
    incoming: draftSchema.parse({}),
    attachmentLines: [sale, tester],
    operatorWords: 'prepara questo file',
    attachmentText: 'DEMO-A | kit 30ml 50ml | Qty 2\nDEMO-A tester | Qty 1',
    isNewRequest: false,
  });
  expect(repeated.lines).toHaveLength(2);
  expect(repeated.lines.map(l => l.ref)).toEqual(['L1', 'L2']);
  const edited = mergeOrderDraft({
    base: first,
    incoming: draftSchema.parse({ lines: [{ ref: 'L1', query: 'DEMO-A Pebble hand wash 250 ml', quantity: 5 }] }),
    incomingLines: [{ ref: 'L1', op: 'edit', query: 'DEMO-A Pebble hand wash 250 ml', quantity: 5 }],
    operatorWords: 'make it five',
    isNewRequest: false,
  });
  expect(edited.lines.map(l => ({ ref: l.ref, quantity: l.quantity, tester: l.tester }))).toEqual([
    { ref: 'L1', quantity: 5, tester: undefined },
    { ref: 'L2', quantity: 1, tester: true },
  ]);
});

it('treats omission as keep and op=delete as remove', () => {
  const base = mergeOrderDraft({
    incoming: draftSchema.parse({ lines: [{ query: 'A', quantity: 1 }, { query: 'B', quantity: 1 }] }),
    operatorWords: 'two lines',
    isNewRequest: true,
  });
  const omitted = mergeOrderDraft({
    base, incoming: draftSchema.parse({ notes: 'hold the order' }), incomingLines: [], operatorWords: 'add a note', isNewRequest: false,
  });
  expect(omitted.lines).toHaveLength(2);
  expect(omitted.notes).toBe('hold the order');
  const deleted = mergeOrderDraft({
    base, incoming: draftSchema.parse({}), incomingLines: [{ ref: 'L2', op: 'delete', query: 'B' }], operatorWords: 'drop the second', isNewRequest: false,
  });
  expect(deleted.lines.map(l => l.ref)).toEqual(['L1']);
});

it('loads older persisted drafts and choices without refs as L1… and still honours the stored pick', async () => {
  const legacy = loadConversation(JSON.stringify({
    orderId: 'old', revision: 2, status: 'suspended', policy: 'test',
    draft: { clientQuery: 'Example Studio', clientId: 201, lines: [{ query: 'Pebble hand wash 250 ml', productId: 101, quantity: 2 }] },
    confirmedChoices: [{ field: 'lines.0', id: 101, queryHash: 'x', identityHash: 'y' }],
  }));
  expect(legacy.draft.clientId).toBe('201');
  expect(legacy.draft.lines[0]).toMatchObject({ productId: '101', ref: 'L1' });
  expect(legacy.confirmedChoices?.[0]?.id).toBe('101');
  expect(ensureLineRefs(legacy.draft.lines)[0]?.ref).toBe('L1');
});

it('cancels customer and shipping context with the request; a later request starts empty', async () => {
  const outcome = await runConversation(config(), new DemoConnector(), [
    { text: 'ordine per Example Studio: 2 Pebble hand wash 250 ml, spedizione 0 euro' },
    { text: 'annulla' },
    { text: 'nuovo ordine: 1 Linen candle 200 g' },
  ], { converse: scriptedTurns([
    draftSchema.parse({ clientQuery: 'Example Studio', lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }], shippingPrice: 0 }),
    'cancel',
    draftSchema.parse({ lines: [{ query: 'Linen candle 200 g', quantity: 1 }] }),
  ]) });
  expect(outcome.open?.draft.clientQuery).not.toMatch(/Example Studio/);
  expect(outcome.open?.draft.clientId).toBeUndefined();
  expect(outcome.open?.draft.shippingPrice).toBeUndefined();
  expect(outcome.open?.draft.lines.some(l => /Linen candle/i.test(l.query))).toBe(true);
});

it('keeps an explicit shipping 0 across later turns and does not treat unknown as 0', async () => {
  const kept = await runConversation(config(), new DemoConnector(), [
    { text: 'ordine per Example Studio: 2 Pebble hand wash 250 ml, nessuna spedizione' },
    { text: 'nota: hold at desk' },
  ], { converse: scriptedTurns([
    draftSchema.parse({ clientQuery: 'Example Studio', lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }], shippingPrice: 0 }),
    draftSchema.parse({ notes: 'hold at desk' }),
  ]) });
  expect(kept.open?.draft.shippingPrice).toBe(0);
  const unknown = await runConversation(config(), new DemoConnector(), [
    { text: 'ordine per Example Studio: 2 Pebble hand wash 250 ml' },
  ], { converse: scriptedTurns([
    draftSchema.parse({ clientQuery: 'Example Studio', lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }] }),
  ]) });
  expect(unknown.open?.draft.shippingPrice).toBeUndefined();
  expect(unknown.open?.issues?.some(i => i.field === 'shippingPrice')).toBe(true);
  expect(unknown.open?.draft.shippingPrice === 0).toBe(false);
});

it('locks eight unique codes from a long kit description and does not treat printed kit sizes as variant constraints', async () => {
  const connector = new DemoConnector();
  const kits = Array.from({ length: 8 }, (_, i) => ({
    id: `k${i + 1}`, code: `KIT-${i + 1}`, name: `Grove kit ${i + 1}`, description: '', netPrice: 10 + i,
  }));
  connector.products.push(...kits);
  const rows = kits.map((kit, i) => `${kit.code} | ${kit.name} | contents 30ml 50ml 100ml 250ml | Qty: ${i + 1}`);
  const attachmentText = rows.join('\n');
  const lines = kits.map((kit, i) => ({ query: `${kit.code} ${kit.name} contents 30ml 50ml 100ml 250ml`, quantity: i + 1 }));
  const result = await api(connector, judge).order(draftSchema.parse({ clientQuery: 'Example Studio', lines }), {
    orderId: 'kits', revision: 1, operatorText: `prepara questo file\n${attachmentText}`, operatorWords: 'prepara questo file', attachmentText,
  }, '2026-01-15');
  expect(result.draft.lines.map(l => l.productId)).toEqual(kits.map(k => k.id));
  const kitIssues = result.status === 'needs' ? result.issues : [];
  expect(kitIssues.filter(i => i.field.startsWith('lines.') && i.message.match(/size or variant/i))).toEqual([]);
});

it('does not treat a fuzzy singleton as exact, even when the matcher says matched', async () => {
  const connector = new DemoConnector();
  connector.clients.push(maplePine);
  const spoken = 'ordine per Maple';
  const result = await api(connector, judge).order(draftSchema.parse({ clientQuery: 'Maple', lines: [{ query: 'pebble wash', quantity: 2 }] }), {
    orderId: 'fuzzy', revision: 1, operatorText: spoken, operatorWords: spoken,
  }, '2026-01-15');
  expect(result.status).toBe('needs');
  expect(result.draft.clientId).toBeUndefined();
  expect(result.draft.lines[0]?.productId).toBeUndefined();
  expect(result.status === 'needs' && result.issues.find(i => i.field === 'client')?.candidates?.some(c => c.id === maplePine.id)).toBe(true);
  expect(forAgent(result).customer).toMatchObject({ status: expect.stringMatching(/unconfirmed|ambiguous/) });
});

it('asks on an explicit operator size/variant conflict instead of trusting the printed code', async () => {
  const spoken = 'DEMO-A 500 ml';
  const result = await api().order(draftSchema.parse({ clientQuery: 'Example Studio', lines: [{ query: 'DEMO-A 500 ml', quantity: 2 }] }), {
    orderId: 'variant', revision: 1, operatorText: spoken, operatorWords: spoken,
  }, '2026-01-15');
  expect(result.draft.lines[0]?.productId).toBeUndefined();
  expect(result.status === 'needs' && result.issues.find(i => i.field === 'lines.0')?.message).toMatch(/size or variant/i);
});

it('maps a tester mark to the unique tester product at its own price, including zero, as a second line', async () => {
  const connector = new DemoConnector();
  connector.products.push(
    { id: '808', code: 'SAMPLE-T', name: 'TESTER Pebble wash', description: '', netPrice: 0 },
  );
  const spoken = 'Example Studio SOAP250 DEMO-A sale 2 and tester 1';
  const result = await complete({
    ...draft(),
    lines: [
      { query: 'DEMO-A Pebble hand wash 250 ml', quantity: 2 },
      { query: 'DEMO-A Pebble hand wash 250 ml tester', quantity: 1, tester: true },
    ],
  }, connector, spoken);
  expect(result.ready).toBe(true);
  if (!result.ready) return;
  const merchandise = result.order.lines.filter(l => !l.shipping);
  expect(merchandise).toHaveLength(2);
  expect(merchandise[0]).toMatchObject({ productId: '101', quantity: 2, netPrice: 12 });
  expect(merchandise[1]).toMatchObject({ productId: '808', quantity: 1, netPrice: 0 });
});

it('confirms a customer only with an exact typed name, a pick, or yes bound to the active named candidate, not file consent or a stale yes', async () => {
  const connector = new DemoConnector();
  connector.clients.push(maplePine);
  const drafts = api(connector, judge);
  const asked = await drafts.order(draftSchema.parse({ clientQuery: 'Maple', lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }], shippingPrice: 8 }), {
    orderId: 'cust', revision: 1, operatorText: 'ordine per Maple', operatorWords: 'ordine per Maple',
  }, '2026-01-15');
  expect(asked.draft.clientId).toBeUndefined();
  const fileYes = await drafts.order(asked.draft, {
    orderId: 'cust', revision: 2, operatorText: 'yes prepare this file', operatorWords: 'ordine per Maple\nyes prepare this file',
    turnWords: 'yes prepare this file', pendingQuestion: { field: 'client', ids: [maplePine.id], revision: 1, named: maplePine.name },
  }, '2026-01-15');
  expect(fileYes.draft.clientId).toBeUndefined();
  const confirmed = await drafts.order(asked.draft, {
    orderId: 'cust', revision: 3, operatorText: 'yes', operatorWords: 'ordine per Maple\nyes', turnWords: 'yes',
    pendingQuestion: { field: 'client', ids: [maplePine.id], revision: 2, named: maplePine.name },
  }, '2026-01-15');
  expect(confirmed.draft.clientId).toBe(maplePine.id);
});

it('keeps matcher no-match candidates instead of claiming the catalogue is absent', async () => {
  const connector = new DemoConnector();
  const result = await api(connector, noMatch).order(
    draftSchema.parse({ clientQuery: 'Pebble', lines: [{ query: 'pebble wash', quantity: 2 }] }),
    { orderId: 'keep', revision: 1, operatorText: 'pebble wash', operatorWords: 'pebble wash' },
    '2026-01-15',
  );
  expect(result.status).toBe('needs');
  if (result.status !== 'needs') return;
  const line = result.issues.find(i => i.field === 'lines.0');
  expect(line?.candidates?.length).toBeGreaterThan(0);
  expect(line?.message).not.toMatch(/catalogue absent/i);
  expect(result.draft.lines[0]?.productId).toBeUndefined();
});

it('keeps explicit-only notes and does not invent them from an attachment', async () => {
  const merged = mergeOrderDraft({
    incoming: draftSchema.parse({ notes: '' }),
    attachmentLines: [{ query: 'DEMO-A', quantity: 1 }],
    operatorWords: 'prepara questo file',
    attachmentText: 'Please deliver tomorrow to the warehouse',
    isNewRequest: true,
  });
  expect(merged.notes).toBe('');
  const noted = mergeOrderDraft({
    base: merged, incoming: draftSchema.parse({ notes: 'hold at desk' }), operatorWords: 'nota: hold at desk', isNewRequest: false,
  });
  expect(noted.notes).toBe('hold at desk');
});

it('matches the preview: needs never looks ready, and a needs draft cannot be saved', async () => {
  const connector = new DemoConnector();
  const result = await api(connector).order(draftSchema.parse({ clientQuery: 'Maple', lines: [{ query: 'pebble wash', quantity: 2 }] }), {
    orderId: 'guard', revision: 1, operatorText: 'Maple pebble wash', operatorWords: 'Maple pebble wash',
  }, '2026-01-15');
  const shown = forAgent(result, 1);
  expect(shown.status).toBe('needs');
  expect(shown.note).toMatch(/never say the draft is ready while status is needs/i);
  const c = config(); c.orderSavingEnabled = true;
  const journal = new WriteJournal(':memory:'); await journal.init();
  try {
    const save = orderCreator(c, connector, journal);
    await expect(save({
      orderId: 'guard', revision: 1, status: 'suspended', draft: result.draft, policy: policyFingerprint(c), issues: result.status === 'needs' ? result.issues : [],
    })).rejects.toThrow();
    expect(connector.createCalls).toBe(0);
    const order = await prepared();
    const totals = await connector.calculateTotals(order);
    const saved = await save({ orderId: 'ready', revision: 1, status: 'ready', draft: draft(), policy: policyFingerprint(c), prepared: order, totals });
    expect(saved.id).toBeTruthy();
    expect(await save({ orderId: 'ready', revision: 1, status: 'ready', draft: draft(), policy: policyFingerprint(c), prepared: order, totals })).toEqual(saved);
    expect(connector.createCalls).toBe(1);
  } finally { journal.close(); }
});
