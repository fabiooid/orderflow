import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { LibSQLStore } from '@mastra/libsql';
import { TelegramController } from '../src/telegram/controller.js';
import { TelegramStore } from '../src/telegram/store.js';
import { createConversationEngine, type Converse } from '../src/telegram/engine.js';
import { DemoConnector } from '../src/connector/demo.js';
import { draftSchema } from '../src/domain/types.js';
import { config, message, press, stubEngine } from './helpers.js';

it('persists routing and skips replayed messages after a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tg-tests-'));
  const url = `file:${join(dir, 'state.db')}`;
  let store = new TelegramStore(url, 'demo');
  const engine = stubEngine();
  const send = vi.fn(async (_text: string, _reply: number) => ({ message_id: 100 }));
  try {
    await store.init();
    await new TelegramController(config(), 'bot', store, engine, send).handle(message(1, '@bot order two bottles'));
    store.close(); store = new TelegramStore(url, 'demo'); await store.init();
    const controller = new TelegramController(config(), 'bot', store, engine, send);
    await controller.handle(message(1, '@bot order two bottles'));
    expect(engine.turn).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
    await controller.handle(message(2, 'make that three', 100, 7));
    expect(engine.turn.mock.calls[1]![0].request?.orderId).toBe('u1');
    expect((await store.order('u1'))?.revision).toBe(2);
    expect(await store.offset()).toBe(3);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
it('does not rerun the agent or blindly resend after an uncertain send', async () => {
  const store = new TelegramStore(':memory:', 'demo'); await store.init();
  const engine = stubEngine();
  const send = vi.fn().mockRejectedValue(new Error('timeout'));
  const controller = new TelegramController(config(), 'bot', store, engine, send);
  try {
    await expect(controller.handle(message(1, '@bot order item'))).rejects.toThrow();
    await expect(controller.handle(message(1, '@bot order item'))).rejects.toThrow(/uncertain/);
    expect(engine.turn).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
    await store.sent(1, 100); // Operator has verified delivery in the group.
    await controller.handle(message(1, '@bot order item'));
    expect(await store.offset()).toBe(2);
  } finally { store.close(); }
});
it('answers replies to an older summary without the agent, and marks a preview checked with its button', async () => {
  const store = new TelegramStore(':memory:', 'demo'); await store.init();
  let messageId = 100;
  const engine = stubEngine();
  const send = vi.fn(async (_text: string, _reply: number, _keyboard?: unknown) => ({ message_id: messageId++ }));
  const controller = new TelegramController(config(), 'bot', store, engine, send);
  try {
    await controller.handle(message(1, '@bot order first'));
    await controller.handle(message(2, 'edit first', 100, 7));
    expect(engine.turn).toHaveBeenCalledTimes(2);
    // Preview mode has no save: the summary offers the review button instead.
    expect(JSON.stringify(send.mock.calls[1]![2])).toContain('review:u1:2');
    await controller.handle(message(3, 'and another edit', 100));
    expect(send.mock.calls.at(-1)![0]).toContain('versione precedente');
    expect(engine.turn).toHaveBeenCalledTimes(2);
    await controller.handle(press(4, 'review:u1:1', 100));
    expect((await store.order('u1'))?.status).toBe('ready');
    await controller.handle(press(5, 'review:u1:2', 101));
    expect((await store.order('u1'))?.status).toBe('reviewed');
  } finally { store.close(); }
});

it('runs the real order API from scripted agent turns, with a candidate picked by button', async () => {
  const storage = new LibSQLStore({ id: 'tg-engine', url: ':memory:' });
  const store = new TelegramStore(':memory:', 'engine'); await store.init();
  let messageId = 100;
  const connector = new DemoConnector();
  connector.products.push({ id: 104, code: 'DEMO-A5', name: 'Pebble hand wash 500 ml', description: '', netPrice: 20 });
  const send = vi.fn(async (_text: string, _reply: number, _keyboard?: unknown) => ({ message_id: messageId++ }));
  // The scripted agent sends the drafts a model would, starting from the open request it is shown.
  const converse = vi.fn<Converse>()
    .mockImplementationOnce(async (_prompt, act) => { await act.order(draftSchema.parse({ clientQuery: 'Example Studio', lines: [{ query: 'Pebble hand wash', quantity: 2 }] })); return { reply: 'Quale formato?', locale: 'it' }; })
    .mockImplementationOnce(async (prompt, act) => { await act.order({ ...prompt.openRequest!.draft, shippingPrice: 8 }); return { reply: '', locale: 'it' }; });
  try {
    const engine = createConversationEngine(config(), connector, storage, { converse });
    const controller = new TelegramController(config(), 'bot', store, engine, send);
    await controller.handle(message(1, '@bot ordine per Example Studio: 2 pebble hand wash'));
    const first = await store.order('u1');
    expect(first?.status).toBe('suspended');
    const [text, , keyboard] = send.mock.calls[0]!;
    expect(text).toMatch(/^Quale formato\?\n\n📝 Bozza ordine/);
    expect(text).toContain('🏪 Example Studio');
    expect(text).toContain('2 × Pebble hand wash ❓');
    expect(JSON.stringify(keyboard)).toContain('pick:u1:1:lines.0:104');
    // The pick goes straight to the order API: no agent turn.
    await controller.handle(press(2, 'pick:u1:1:lines.0:104', 100));
    expect(converse).toHaveBeenCalledTimes(1);
    expect((await store.order('u1'))?.draft.lines[0]?.productId).toBe(104);
    expect(send.mock.calls[1]![0]).toContain('🚚 Consegna: ❓');
    await controller.handle(message(3, 'spedizione 8', 101, 7));
    const ready = await store.order('u1');
    expect(ready?.status).toBe('ready');
    expect(ready?.prepared?.lines.map(l => [l.productId, l.quantity])).toEqual([[104, 2], [900, 1]]);
    expect(send.mock.calls[2]![0]).toContain('📦 Anteprima ordine');
    expect(connector.createCalls).toBe(0);
  } finally { store.close(); await storage.close(); }
});
it('cancels in words through the agent, and reports nothing to cancel afterwards', async () => {
  const store = new TelegramStore(':memory:', 'cancel'); await store.init();
  let messageId = 100;
  const engine = stubEngine();
  const send = vi.fn(async (_text: string, _reply: number) => ({ message_id: messageId++ }));
  const controller = new TelegramController(config(), 'bot', store, engine, send);
  try {
    await controller.handle(message(1, '@bot ordine per Cliente Test'));
    engine.turn.mockResolvedValueOnce({ text: 'Ok.', reply: '', locale: 'it', cancel: true });
    await controller.handle(message(2, 'lascia stare'));
    expect((await store.order('u1'))?.status).toBe('cancelled');
    expect(send.mock.calls[1]![0]).toContain('Annullato');
    await controller.handle(press(3, 'cancel:u1:1', 100));
    expect(send.mock.calls.at(-1)![0]).toContain('Nessuna richiesta aperta da annullare');
  } finally { store.close(); }
});
it('lists every open request when the agent is blocked from starting another, and voids them all with a button bound to the list', async () => {
  const store = new TelegramStore(':memory:', 'void'); await store.init();
  const old = (orderId: string, status: 'new' | 'suspended' | 'saving', kind?: 'customer') => ({ orderId, revision: 0, status, ...(kind ? { kind } : {}), startedAt: '2026-09-29T09:00:00.000Z', draft: draftSchema.parse({ clientQuery: `client ${orderId}` }), policy: 'earlier' });
  for (const [i, c] of [old('u1', 'suspended'), old('u2', 'new', 'customer'), old('u3', 'saving')].entries()) await store.plan(90 + i, { replyTo: 90 + i, texts: [], order: c });
  let messageId = 100;
  const engine = stubEngine();
  const send = vi.fn(async (_text: string, _reply: number, _keyboard?: unknown) => ({ message_id: messageId++ }));
  const controller = new TelegramController(config(), 'bot', store, engine, send);
  try {
    // The newest open request is saving and cannot be edited, so the agent works without one and is told what blocks it.
    await controller.handle(message(1, 'nuovo ordine per Cliente Test'));
    expect(engine.turn.mock.calls[0]![0]).toMatchObject({ request: undefined, locked: expect.stringContaining('client u1') });
    const [text, , keyboard] = send.mock.calls[0]!;
    expect(text).toContain('Ci sono 3 richieste aperte');
    expect(text).toContain('Nuovo cliente — client u2 — appena iniziato');
    expect(text).toContain('Ordine — client u1 — in attesa di dettagli');
    expect(text).toContain('configurazione precedente');
    expect(JSON.stringify(keyboard)).toContain('cancelall:u3:0');
    expect(JSON.stringify(keyboard)).toContain('Annulla tutte (2)');
    expect((await store.update(1))?.plan.activeOrderId).toBe('u3');
    // A button whose list is no longer current shows the new list and voids nothing.
    await controller.handle(press(2, 'cancelall:u1:0', 100));
    expect(send.mock.calls.at(-1)![0]).toContain('Le richieste aperte sono cambiate');
    expect((await store.order('u1'))?.status).toBe('suspended');
    await controller.handle(press(3, 'cancelall:u3:0', 100));
    expect(send.mock.calls.at(-1)![0]).toContain('Annullate 2 richieste');
    expect(send.mock.calls.at(-1)![0]).toContain('1 salvataggio da verificare');
    expect((await store.order('u1'))?.status).toBe('cancelled');
    expect((await store.order('u2'))?.status).toBe('cancelled');
    expect((await store.order('u3'))?.status).toBe('saving');
    expect((await store.update(3))?.plan.cancelled).toHaveLength(2);
  } finally { store.close(); }
});
it('keeps a request from an earlier configuration, checked again under the current one, for the agent to continue', async () => {
  const store = new TelegramStore(':memory:', 'supersede'); await store.init();
  const draft = draftSchema.parse({ clientQuery: 'Fable Goods', lines: [{ query: 'pebble', quantity: 20 }] });
  await store.plan(90, { replyTo: 90, texts: [], order: { orderId: 'u0', revision: 2, status: 'suspended', draft, policy: 'earlier' } });
  const engine = stubEngine('suspended', 'Draft');
  engine.revise.mockImplementation(async previous => ({ order: { ...previous, revision: previous.revision + 1 }, text: 'Rechecked draft' }));
  engine.turn.mockResolvedValueOnce({ text: 'Not created yet.', reply: '', locale: 'it' });
  const send = vi.fn(async (_text: string, _reply: number) => ({ message_id: 100 }));
  const controller = new TelegramController(config(), 'bot', store, engine, send);
  try {
    await controller.handle(message(1, 'hai creato il cliente?', 90));
    // The agent sees the same order, now under the current configuration; nothing was cancelled.
    expect(engine.turn.mock.calls[0]![0].request).toMatchObject({ orderId: 'u0', revision: 3, draft, policy: expect.not.stringMatching(/^earlier$/) });
    expect((await store.order('u0'))).toMatchObject({ status: 'suspended', revision: 3 });
    expect(send.mock.calls[0]![0]).toBe('La configurazione è cambiata: ho ricontrollato la richiesta aperta.\n\nNot created yet.\n\nRechecked draft');
    // A button from before the change is stale: it is dropped without saving or replying.
    await controller.handle(press(2, 'save:u0:2', 90));
    expect(send).toHaveBeenCalledTimes(1);
  } finally { store.close(); }
});

it('lets an order take over the open new-customer request, carrying the customer into it', async () => {
  const storage = new LibSQLStore({ id: 'tg-takeover', url: ':memory:' });
  const store = new TelegramStore(':memory:', 'takeover'); await store.init();
  let messageId = 100;
  const send = vi.fn(async (_text: string, _reply: number, _keyboard?: unknown) => ({ message_id: messageId++ }));
  const customer = { name: 'Marcello Bello', street: 'Via Pippo 5', postalCode: '24050', city: 'Popolone', province: 'BG', country: 'IT' };
  const converse = vi.fn<Converse>()
    .mockImplementationOnce(async (_prompt, act) => { await act.customer(draftSchema.parse({ newClient: customer })); return { reply: '', locale: 'it' }; })
    .mockImplementationOnce(async (prompt, act) => {
      expect(prompt.openRequest).toMatchObject({ kind: 'customer', draft: { newClient: customer } });
      await act.order(draftSchema.parse({ newClient: prompt.openRequest!.draft.newClient, lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }], shippingPrice: 8 }));
      return { reply: '', locale: 'it' };
    });
  try {
    const c = config(); c.clients.requiredFields = [];
    const engine = createConversationEngine(c, new DemoConnector(), storage, { converse });
    const controller = new TelegramController(c, 'bot', store, engine, send);
    await controller.handle(message(1, '@bot crea cliente Marcello Bello, Via Pippo 5, 24050 Popolone BG'));
    expect(await store.order('u1')).toMatchObject({ kind: 'customer', status: 'ready' });
    await controller.handle(message(2, 'ok crea ordine'));
    expect((await store.order('u1'))?.status).toBe('cancelled');
    const order = await store.order('u2');
    expect(order).toMatchObject({ status: 'ready', draft: { newClient: { name: 'Marcello Bello' } } });
    expect(order?.kind).toBeUndefined();
    expect(send.mock.calls[1]![0]).toContain('📦 Anteprima ordine');
  } finally { store.close(); await storage.close(); }
});
it('lists the request that blocks a new one instead of saying none is open', async () => {
  const store = new TelegramStore(':memory:', 'blocked'); await store.init();
  const engine = stubEngine('ready', 'Summary', 'customer');
  const send = vi.fn(async (_text: string, _reply: number) => ({ message_id: 100 }));
  const controller = new TelegramController(config(), 'bot', store, engine, send);
  try {
    await controller.handle(message(1, '@bot crea cliente Test'));
    engine.turn.mockResolvedValueOnce({ text: 'C’è una richiesta cliente aperta.', reply: '', locale: 'it', blocked: true });
    await controller.handle(message(2, 'nuovo cliente Altro'));
    expect(send.mock.calls[1]![0]).toContain('C’è già una richiesta aperta');
    expect(send.mock.calls[1]![0]).not.toContain('Nessuna richiesta aperta');
  } finally { store.close(); }
});
it('remembers the agent\'s own words, and application drafts only as a labelled first line', async () => {
  const { remembered } = await import('../src/telegram/engine.js');
  expect(remembered({ texts: ['Manca il paese?\n\n👤 Nuovo cliente\n━━━━\n\n🏪 Pippo'], agentText: 'Manca il paese?' })).toBe('Manca il paese?\n[Application message: 👤 Nuovo cliente]');
  expect(remembered({ texts: ['Annullato. Nulla è stato salvato.'] })).toBe('[Application message: Annullato. Nulla è stato salvato.]');
  expect(remembered({ texts: ['Linen candle 200 g — DEMO-B — €20,00'], agentText: 'Linen candle 200 g — DEMO-B — €20,00' })).toBe('Linen candle 200 g — DEMO-B — €20,00');
});
