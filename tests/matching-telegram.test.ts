import { expect, it, vi } from 'vitest';
import { LibSQLStore } from '@mastra/libsql';
import { createConversationEngine, type Converse } from '../src/telegram/engine.js';
import { TelegramController, type ConversationEngine } from '../src/telegram/controller.js';
import { TelegramStore, type Conversation } from '../src/telegram/store.js';
import { DemoConnector } from '../src/connector/demo.js';
import { draftSchema } from '../src/domain/types.js';
import { matchingConfigSchema } from '../src/matching/config.js';
import type { SelectionResult } from '../src/matching/types.js';
import type { SelectMany } from '../src/matching/resolver.js';
import { config, draft, message, press, prepared, stubEngine } from './helpers.js';

const on = matchingConfigSchema.parse({ mode: 'on' });
const judge: SelectMany = async requests => requests.map(r => ({ status: 'matched', selectedId: r.kind === 'client' ? 201 : 101,
  evidence: { requestHash: 'test', promptVersion: 'test', retrieval: r.retrieval, elapsedMs: 0 } } satisfies SelectionResult));
const fresh = (kind: 'order' | 'customer'): Conversation => ({ orderId: 'new', revision: 0, status: 'new', ...(kind === 'customer' ? { kind } : {}), draft: draftSchema.parse({}), policy: config().policyVersion });

it('judges the operator words, never trusts model-written IDs, and settles a pick by button without the agent', async () => {
  const c = config(); c.telegram.respondToAllMessages = true;
  const store = new TelegramStore(':memory:', 'jev-routing'); await store.init();
  const storage = new LibSQLStore({ id: 'jev-routing', url: ':memory:' });
  const selectMany = vi.fn(judge);
  // The scripted agent writes IDs of its own; the order API must replace them with judged ones.
  const converse = vi.fn<Converse>()
    .mockImplementationOnce(async (_prompt, act) => { await act.order({ ...draft(), clientId: 202, lines: [{ query: 'small amber wash', productId: 102 }] }); return { reply: '', locale: 'en' }; })
    .mockImplementationOnce(async (prompt, act) => { await act.order({ ...prompt.openRequest!.draft, lines: [{ ...prompt.openRequest!.draft.lines[0]!, quantity: 2 }] }); return { reply: '', locale: 'en' }; });
  const engine = createConversationEngine(c, new DemoConnector(), storage, { converse, matching: { config: on, selectMany } });
  let id = 100;
  const controller = new TelegramController(c, 'bot', store, engine, async () => ({ message_id: id++ }));
  try {
    const original = 'The example shop wants the small amber wash';
    await controller.handle(message(1, original));
    expect(selectMany.mock.calls[0]![0].every(r => r.context === original)).toBe(true);
    const first = await store.order('u1');
    expect(first?.status).toBe('suspended');
    expect(first?.draft.lines[0]?.productId).toBe(101);
    await controller.handle(message(2, 'Make it two', 100));
    const next = await store.order('u1');
    expect(next?.status).toBe('ready');
    expect(next?.prepared?.client.id).toBe(201);
    expect(next?.matchingDecisions).toHaveLength(2);
    expect(selectMany.mock.calls[1]![0][0]?.context).toContain('Make it two');
    await controller.handle(press(3, 'pick:u1:2:lines.0:101', 101));
    expect(converse).toHaveBeenCalledTimes(2);
    expect((await store.order('u1'))?.draft.lines[0]?.productId).toBe(101);
    expect((await store.order('u1'))?.matchingDecisions?.find(d => d.field === 'lines.0')?.source).toBe('operator');
  } finally { await engine.shutdown(); store.close(); await storage.close(); }
}, 20000);

it('enabling authoritative matching rechecks a summary prepared under the legacy policy before it can be saved', async () => {
  const c = config(); c.orderSavingEnabled = true;
  const store = new TelegramStore(':memory:', 'jev-policy'); await store.init();
  const order = await prepared();
  const stub = stubEngine();
  stub.turn.mockImplementation(async input => {
    const previous = input.request ?? input.fresh('order');
    return { text: 'Summary', reply: '', locale: 'it', order: { ...previous, revision: previous.revision + 1, status: 'ready', prepared: order, totals: { net: 1, vat: 0, gross: 1 } } };
  });
  const engine: ConversationEngine = { ...stub };
  const send = vi.fn(async (_text: string, _reply: number) => ({ message_id: 100 })); const save = vi.fn();
  try {
    await new TelegramController(c, 'bot', store, engine, send, undefined, save, async () => ({ message_id: 200 })).handle(message(1, '@bot order two'));
    engine.matchingPolicy = 'jev-identities-v1:test';
    await new TelegramController(c, 'bot', store, engine, send, undefined, save, async () => ({ message_id: 200 })).handle(press(2, 'save:u1:1', 100));
    expect(save).not.toHaveBeenCalled();
    // Checked again and shown as a new revision: the old button can no longer save it.
    expect(stub.revise).toHaveBeenCalledTimes(1);
    expect((await store.order('u1'))?.revision).toBe(2);
    expect(send.mock.calls.at(-1)![0]).toContain('La configurazione è cambiata');
  } finally { store.close(); }
});

it('treats a bare name in a customer request as a new customer, not a failed lookup', async () => {
  const storage = new LibSQLStore({ id: 'jev-new-customer', url: ':memory:' });
  const noMatch: SelectMany = async requests => requests.map(r => ({ status: 'no-match', evidence: { requestHash: 'test', promptVersion: 'test', retrieval: r.retrieval, elapsedMs: 0 } } satisfies SelectionResult));
  const converse: Converse = async (_prompt, act) => { await act.customer(draftSchema.parse({ newClient: { name: 'Scemo chi legge' } })); return { reply: '', locale: 'it' }; };
  const engine = createConversationEngine(config(), new DemoConnector(), storage, { converse, matching: { config: on, selectMany: noMatch } });
  try {
    const result = await engine.turn({ text: 'Crea cliente "Scemo chi legge"', operatorText: 'Crea cliente "Scemo chi legge"', senderId: '5', fresh });
    expect(result.text).not.toContain('Nessun cliente corrisponde');
    expect(result.order?.kind).toBe('customer');
    expect(result.order?.draft.newClient?.name).toBe('Scemo chi legge');
    expect(result.order?.draft.clientId).toBeUndefined();
  } finally { await engine.shutdown(); await storage.close(); }
});

it('finishes a customer request without offering creation when an existing customer is picked', async () => {
  const c = config();
  const storage = new LibSQLStore({ id: 'jev-existing-customer', url: ':memory:' });
  const converse = vi.fn<Converse>();
  const engine = createConversationEngine(c, new DemoConnector(), storage, { converse, matching: { config: on, selectMany: judge } });
  try {
    const result = await engine.revise({ orderId: 'existing', kind: 'customer', revision: 1, status: 'suspended', policy: c.policyVersion, draft: { ...draft(), newClient: { name: 'Example shop' } } }, { field: 'client', id: 201 });
    expect(result.order.status).toBe('reviewed');
    expect(result.order.draft.clientId).toBe(201);
    expect(result.order.draft.newClient).toBeUndefined();
    expect(result.text).toContain('201');
    expect(converse).not.toHaveBeenCalled();
  } finally { await engine.shutdown(); await storage.close(); }
});
