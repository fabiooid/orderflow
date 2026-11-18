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
import { confirmedChoices, createIdentityResolver, type SelectMany } from '../src/matching/resolver.js';
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

async function executePrepare(input: Record<string, unknown>, operatorWords: string, matching?: { config: ReturnType<typeof matchingConfigSchema.parse>; selectMany: SelectMany }) {
  const storage = new LibSQLStore({ id: `tool-${Math.random().toString(36).slice(2, 8)}`, url: ':memory:' });
  try {
    const { agent } = createOrderAgent(config(), new DemoConnector(), storage, { enabled: false, rate: 0 }, matching ?? { config: onConfig, selectMany: judge });
    const tools = await agent.listTools();
    const context = new RequestContext();
    startTurn(context, { evidence: operatorWords, operatorWords, senderId: '5', knownPhrases: [] });
    const raw = await tools.prepareOrder!.execute!(input as never, { requestContext: context } as never);
    return { parsed: draftOutput.parse(raw), storage };
  } catch (error) {
    await storage.close();
    throw error;
  }
}

it('exposes needs and ready identity states through the declared prepare-order schema', async () => {
  const needs = await executePrepare({
    clientQuery: 'Maple', clientId: null, newClient: null, manualVatCheck: null,
    lines: [{ ref: null, op: null, query: 'pebble wash', productId: '101', quantity: 2, tester: null, netPrice: null, documentPrice: null }],
    shippingPrice: null, discountPercent: 0, discountShipping: null, delivery: null, notes: '', priceTier: null,
  }, 'ordine per Maple: pebble wash');
  try {
    expect(needs.parsed.status).toBe('needs');
    expect(needs.parsed.revision).toBe(1);
    expect(needs.parsed.customer?.status).toMatch(/unconfirmed|ambiguous|unsupported|missing/);
    expect(needs.parsed.customer?.status).not.toBe('accepted');
    expect(needs.parsed.lines?.[0]?.ref).toMatch(/^L\d+$/);
    expect(needs.parsed.lines?.[0]?.status).not.toBe('accepted');
    expect(needs.parsed.note).toMatch(/never say the draft is ready while status is needs/i);
    expect(JSON.stringify(needs.parsed)).not.toMatch(/secret|password|token/i);
  } finally { await needs.storage.close(); }

  const spoken = 'Order for Example Studio: 2 Pebble hand wash 250 ml, delivery 8 euros.';
  const ready = await executePrepare({
    clientQuery: 'Example Studio', clientId: null, newClient: null, manualVatCheck: null,
    lines: [{ ref: null, op: null, query: 'Pebble hand wash 250 ml — DEMO-A', productId: '102', quantity: 2, tester: null, netPrice: null, documentPrice: null }],
    shippingPrice: 8, discountPercent: 0, discountShipping: null, delivery: null, notes: '', priceTier: null,
  }, spoken, { config: matchingConfigSchema.parse({ mode: 'off' }), selectMany: judge });
  try {
    expect(ready.parsed.status).toBe('ready');
    expect(ready.parsed.customer?.status).toBe('accepted');
    expect(ready.parsed.customer?.name).toBe('Example Studio');
    expect(ready.parsed.lines?.[0]?.status).toBe('accepted');
    expect(ready.parsed.lines?.[0]?.ref).toMatch(/^L\d+$/);
    expect(ready.parsed.note).toMatch(/complete/i);
  } finally { await ready.storage.close(); }
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

it.each(['off', 'on'] as const)('in %s mode keeps a real stored choice, rejects fake hashes and fabricated ids, and drops stale query or catalogue identity', async mode => {
  const connector = new DemoConnector();
  const matching = { config: matchingConfigSchema.parse({ mode }), selectMany: judge };
  const drafts = createDraftApi(config(), connector, createIdentityResolver(config(), connector, matching));
  const spoken = 'ordine per Example Studio: 2 Pebble hand wash 250 ml';
  const first = await drafts.order(draftSchema.parse({
    clientQuery: 'Example Studio', lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }],
  }), { orderId: 'choice', revision: 1, operatorText: spoken, operatorWords: spoken }, '2026-01-15');
  expect(first.draft.lines[0]?.productId).toBe('101');
  const stored = { ...first.draft, lines: ensureLineRefs(first.draft.lines) };
  const choices = confirmedChoices(first.decisions, stored);
  const lineChoice = choices.find(choice => choice.field === 'lines.0');
  expect(lineChoice).toMatchObject({ field: 'lines.0', id: '101', ref: 'L1' });
  expect(lineChoice?.queryHash).toMatch(/^[a-f0-9]{64}$/);
  expect(lineChoice?.identityHash).toMatch(/^[a-f0-9]{64}$/);

  const kept = await drafts.order({ ...stored, lines: [{ ...stored.lines[0]!, quantity: 3 }] }, {
    orderId: 'choice', revision: 2, operatorText: `${spoken}\nmake it 3`, operatorWords: `${spoken}\nmake it 3`, confirmedChoices: choices,
  }, '2026-01-15');
  expect(kept.draft.lines[0]).toMatchObject({ productId: '101', quantity: 3, ref: 'L1' });

  const loaded = loadConversation(JSON.stringify({
    orderId: 'old', revision: 2, status: 'suspended', policy: 'test',
    draft: { clientQuery: 'Example Studio', clientId: 201, lines: [{ query: 'Pebble hand wash 250 ml', productId: 101, quantity: 2 }] },
    confirmedChoices: choices.map(choice => ({ ...choice, id: Number(choice.id) })),
  }));
  const restored = await drafts.order(loaded.draft, {
    orderId: 'old', revision: 3, operatorText: spoken, operatorWords: spoken, confirmedChoices: loaded.confirmedChoices,
  }, '2026-01-15');
  expect(loaded.draft.lines[0]?.ref).toBe('L1');
  expect(restored.draft.lines[0]?.productId).toBe('101');

  const fakeHash = await drafts.order(draftSchema.parse({
    clientQuery: 'Maple', lines: [{ query: 'small pebble', productId: '101', quantity: 2 }],
  }), {
    orderId: 'fake', revision: 1, operatorText: 'ordine per Maple: small pebble', operatorWords: 'ordine per Maple: small pebble',
    confirmedChoices: [{ field: 'lines.0', id: '101', queryHash: 'x', identityHash: 'y' }],
  }, '2026-01-15');
  expect(fakeHash.draft.lines[0]?.productId).toBeUndefined();

  const staleQuery = await drafts.order({
    ...stored, lines: [{ ...stored.lines[0]!, query: 'Linen candle 200 g', productId: '101' }],
  }, { orderId: 'choice', revision: 4, operatorText: spoken, operatorWords: spoken, confirmedChoices: choices }, '2026-01-15');
  expect(staleQuery.draft.lines[0]?.productId).not.toBe('101');

  const fabricated = await drafts.order(draftSchema.parse({
    clientQuery: 'Example Studio', lines: [{ query: 'A1 SAP-MNT scanned label', productId: '101', quantity: 2 }],
  }), { orderId: 'fabricated', revision: 1, operatorText: 'ordine dal modulo', operatorWords: 'ordine dal modulo' }, '2026-01-15');
  expect(fabricated.draft.lines[0]?.productId).toBeUndefined();

  connector.products[0]!.name = 'Renamed pebble';
  connector.products[0]!.code = 'DEMO-RENAMED';
  const staleCatalogue = await drafts.order(stored, {
    orderId: 'choice', revision: 5, operatorText: spoken, operatorWords: spoken, confirmedChoices: choices,
  }, '2026-01-15');
  expect(staleCatalogue.draft.lines[0]?.productId).toBeUndefined();
});

it('drops a model-written productId on a new request and still locks an exact operator name despite an appended code', () => {
  const merged = mergeOrderDraft({
    incoming: draftSchema.parse({
      clientQuery: 'Example Studio',
      lines: [{ query: 'Pebble hand wash 250 ml — DEMO-A', productId: '102', quantity: 2 }],
      shippingPrice: 8,
    }),
    operatorWords: 'Order for Example Studio: 2 Pebble hand wash 250 ml, delivery 8 euros.',
    isNewRequest: true,
  });
  expect(merged.lines[0]?.productId).toBeUndefined();
  expect(merged.shippingPrice).toBe(8);
});

it('fills an empty customer from the attachment header and does not invent notes', () => {
  const merged = mergeOrderDraft({
    incoming: draftSchema.parse({}),
    attachmentLines: [{ query: 'DEMO-A A1 SAP-MNT scanned label', quantity: 2 }],
    operatorWords: 'ordine dal modulo',
    attachmentText: 'Header: Customer: Example Studio\nDEMO-A | A1 SAP-MNT scanned label | Qty: 2',
    isNewRequest: true,
  });
  expect(merged.clientQuery).toBe('Example Studio');
  expect(merged.clientId).toBeUndefined();
  expect(merged.lines[0]).toMatchObject({ query: 'DEMO-A A1 SAP-MNT scanned label', quantity: 2 });
  expect(merged.notes).toBe('');
});

it('treats an attached known name as clientQuery, not a new customer, unless the operator asked to create one', () => {
  const email = 'Example Studio\nExample Street 1, Example City\nP.IVA DEMO-NOT-A-REAL-VAT';
  const fromFile = mergeOrderDraft({
    incoming: draftSchema.parse({ newClient: { name: 'Example Studio', street: 'Example Street 1', city: 'Example City', vatNumber: 'DEMO-NOT-A-REAL-VAT' } }),
    operatorWords: 'ordine',
    attachmentText: email,
    isNewRequest: true,
  });
  expect(fromFile.newClient).toBeUndefined();
  expect(fromFile.clientQuery).toBe('Example Studio');
  const created = mergeOrderDraft({
    incoming: draftSchema.parse({ newClient: { name: 'Marco Esempio', street: 'Via Esempio 5', city: 'Bergamo' } }),
    operatorWords: 'Crea cliente Marco Esempio Via Esempio 5, 24100 Bergamo BG\nok crea ordine',
    isNewRequest: true,
  });
  expect(created.newClient).toMatchObject({ name: 'Marco Esempio', street: 'Via Esempio 5' });
});

it('does not duplicate attachment rows when the model sends the same facts again', () => {
  const attachment = [
    { query: 'DEMO-A A1 SAP-MNT scanned label', quantity: 2 },
    { query: 'unknown scanned row', quantity: 1 },
  ];
  const first = mergeOrderDraft({
    incoming: draftSchema.parse({}),
    attachmentLines: attachment,
    operatorWords: 'ordine dal modulo',
    attachmentText: 'Header: Customer: Example Studio\nDEMO-A | A1 SAP-MNT scanned label | Qty: 2\nunknown scanned row | Qty: 1',
    isNewRequest: true,
  });
  expect(first.lines).toHaveLength(2);
  const again = mergeOrderDraft({
    base: first,
    incoming: draftSchema.parse({}),
    incomingLines: [
      { ref: 'L3', op: 'add', query: 'DEMO-A | A1 SAP-MNT scanned label', quantity: 2 },
      { ref: 'L4', op: 'add', query: 'unknown scanned row', quantity: 1 },
    ],
    attachmentLines: attachment,
    operatorWords: 'ordine dal modulo',
    isNewRequest: false,
  });
  expect(again.lines).toHaveLength(2);
  expect(again.lines.map(line => line.ref)).toEqual(['L1', 'L2']);
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

it('re-renders an open order when the model does not call a draft tool', async () => {
  const outcome = await runConversation(config(), new DemoConnector(), [
    { text: 'ordine per Example Studio: 2 Pebble hand wash 250 ml' },
    { text: "ok mostrami l'ordine" },
  ], { converse: async (prompt, act) => {
    if (!prompt.openRequest) {
      await act.order(draftSchema.parse({
        clientQuery: 'Example Studio',
        lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }],
      }));
    }
    return { reply: 'eccolo', locale: 'it' };
  } });
  expect(outcome.open?.draft.clientId).toBe('201');
  expect(outcome.open?.draft.lines.some(l => l.productId === '101' || /pebble/i.test(l.query))).toBe(true);
  expect(outcome.replies.at(-1)).toMatch(/Bozza ordine|Anteprima ordine/);
});

it('takes over a customer request when they ask to create an order, even if the model stays on prepare-customer', async () => {
  const customer = { name: 'Marco Esempio', street: 'Via Esempio 5', postalCode: '24100', city: 'Bergamo', province: 'BG', country: 'IT' };
  const outcome = await runConversation(config(), new DemoConnector(), [
    { text: 'Crea cliente: Marco Esempio Via Esempio 5, 24100 Bergamo BG' },
    { text: 'ok crea ordine' },
  ], { converse: async (_prompt, act) => {
    await act.customer(draftSchema.parse({ newClient: customer }));
    return { reply: 'manca email', locale: 'it' };
  } });
  expect(outcome.open?.kind).not.toBe('customer');
  expect(outcome.open?.draft.newClient).toMatchObject({ name: 'Marco Esempio', country: 'IT' });
  expect(outcome.replies.some(r => /Nessuna richiesta aperta|annullarla/i.test(r))).toBe(false);
});

it('applies a labelled customer follow-up when the model skips prepare-order', async () => {
  const connector = new DemoConnector();
  connector.clients.push(maplePine);
  const northwind = { id: '202', name: 'Northwind Bistro', country: 'IT', street: 'Via Nord 5', city: 'Bergamo', postalCode: '24100', email: 'orders@northwind.invalid', vatNumber: 'DEMO-NORTHWIND', notes: '' };
  connector.clients.push(northwind);
  const outcome = await runConversation(config(), connector, [
    { text: 'ordine per Example Studio: 2 Pebble hand wash 250 ml, spedizione 8 euro' },
    { text: 'cliente Northwind Bistro' },
  ], { converse: async (prompt, act) => {
    if (!prompt.openRequest) {
      await act.order(draftSchema.parse({
        clientQuery: 'Example Studio',
        lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }],
        shippingPrice: 8,
      }));
    }
    return { reply: '', locale: 'it' };
  } });
  expect(outcome.open?.draft.clientId).toBe('202');
  expect(outcome.open?.draft.newClient).toBeUndefined();
  expect(outcome.open?.draft.lines.some(l => l.productId === '101' || /pebble/i.test(l.query))).toBe(true);
});

it('opens a draft from a client search when the model never calls prepare-order', async () => {
  const storage = new LibSQLStore({ id: `search-skip-${Math.random().toString(36).slice(2, 8)}`, url: ':memory:' });
  try {
    const connector = new DemoConnector();
    connector.clients.push(maplePine);
    const { agent } = createOrderAgent(config(), connector, storage);
    const tools = await agent.listTools();
    const outcome = await runConversation(config(), connector, [{ text: 'ordine per Maple' }], {
      converse: async (_prompt, _act, requestContext) => {
        await tools.searchClients!.execute!({ query: 'Maple' }, { requestContext } as never);
        return { reply: 'Trovato Maple & Pine.', locale: 'it' };
      },
    });
    expect(outcome.open?.draft.clientId).toBeUndefined();
    expect(outcome.open?.status).toBe('suspended');
    expect(outcome.open?.draft.clientQuery).toMatch(/Maple/i);
    expect(outcome.open?.issues?.some(i => i.field === 'client' && i.candidates?.some(c => c.id === maplePine.id))).toBe(true);
    expect(outcome.replies.at(-1)).toMatch(/🏪 Maple(?: & Pine Trading Ltd)? ❓/);
  } finally { await storage.close(); }
});
