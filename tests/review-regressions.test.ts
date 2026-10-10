import { mixedPdf } from './pdf-fixture.js';
import { createVisionDocumentProvider } from '../src/documents/reader.js';
import { expect, it, vi } from 'vitest';
import { config, draft, prepared, stubEngine } from './helpers.js';
import { TelegramStore, type Conversation } from '../src/channel/store.js';
import { TelegramController } from '../src/channel/controller.js';
import { orderCreator } from '../src/channel/order.js';
import { customerCreator } from '../src/channel/customer.js';
import { customerDetails } from '../src/domain/customer.js';
import { WriteJournal, PreflightFailed } from '../src/storage/write-journal.js';
import { DemoConnector } from '../src/connector/demo.js';
import { createMediaReader, modelReader } from '../src/channel/media.js';
import type { Agent } from '@mastra/core/agent';
import { customerPreview, orderPreview } from '../src/channel/preview.js';

const chat = { id: Number(config().channel.groupId), type: 'supergroup' };
const from = { id: 5, is_bot: false };
const message = (id: number, text: string) => ({ update_id: id, message: { message_id: id, chat, from, text } });
const photo = (id: number) => ({ update_id: id, message: { message_id: id, chat, from, photo: [{ file_id: 'test' }] } });
const button = (id: number, messageId: number, data: string) => ({ update_id: id, callback_query: { id: `cb${id}`, from, data, message: { message_id: messageId, chat } } });

it.each(['replacement', 'revision', 'new-request'] as const)('rejects attachment approval after %s changes its context', async change => {
  const store = new TelegramStore(':memory:', change); await store.init();
  let mid = 100;
  const engine = stubEngine();
  const read = vi.fn(async () => ({ text: 'old attachment' }));
  const send = vi.fn(async (_text: string) => ({ message_id: mid++ }));
  const ctl = new TelegramController(config(), 'bot', store, engine, send, undefined, undefined, undefined, undefined, read);
  try {
    if (change !== 'new-request') await ctl.handle(message(1, '@bot ordine A'));
    await ctl.handle(photo(2));
    if (change === 'replacement') { await ctl.handle(button(3, 100, 'cancel:u1:1')); await ctl.handle(message(4, '@bot ordine B')); }
    else if (change === 'revision') await ctl.handle(message(3, 'make it three'));
    else await ctl.handle(message(3, '@bot ordine B'));
    const before = engine.turn.mock.calls.length;
    await ctl.handle(button(5, change === 'new-request' ? 100 : 101, 'media:2:y'));
    expect(engine.turn).toHaveBeenCalledTimes(before);
    expect(read).not.toHaveBeenCalled();
    expect(send.mock.calls.at(-1)?.[0]).toContain('richiesta è cambiata');
    expect(await store.pending({ message: 2 })).toBeUndefined();
  } finally { store.close(); }
});

it('blocks edits, cancellation and repeat creation after an uncertain customer write', async () => {
  const store = new TelegramStore(':memory:', 'customer'); await store.init();
  let mid = 100;
  const engine = stubEngine('ready', 'Summary', 'customer');
  const create = vi.fn(async () => { throw new Error('Response lost after remote save'); });
  const send = vi.fn(async (_text: string) => ({ message_id: mid++ }));
  const ctl = new TelegramController(config(), 'bot', store, engine, send, create);
  try {
    await ctl.handle(message(1, '@bot crea il cliente Test'));
    await ctl.handle(button(2, 100, 'customer:u1:1'));
    expect((await store.order('u1'))?.status).toBe('saving');
    await ctl.handle(message(3, 'change the name'));
    await ctl.handle(button(4, 100, 'customer:u1:1'));
    await ctl.handle(button(5, 100, 'cancel:u1:1'));
    await ctl.handle(message(6, '@bot crea il cliente Another'));
    expect((await store.order('u1'))?.status).toBe('saving');
    // The agent never gets the saving request to change, and is told it blocks new ones.
    expect(engine.turn.mock.calls.slice(1).every(([input]) => !input.request && input.locked?.includes('salvataggio da verificare'))).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.map(([text]) => text).join('\n')).not.toContain('Nulla è stato salvato');
  } finally { store.close(); }
});

it('retries a failed totals read without poisoning the write journal and replays successful writes', async () => {
  const c = config(); c.orderSavingEnabled = true;
  const connector = new DemoConnector();
  const order = await prepared(), totals = await connector.calculateTotals(order);
  const calculate = vi.spyOn(connector, 'calculateTotals').mockRejectedValueOnce(new Error('Read timeout'));
  const journal = new WriteJournal(':memory:'); await journal.init();
  const state: Conversation = { orderId: 'retry', revision: 1, status: 'ready', draft: draft(), policy: '', prepared: order, totals };
  try {
    const save = orderCreator(c, connector, journal);
    await expect(save(state)).rejects.toBeInstanceOf(PreflightFailed);
    expect(connector.createCalls).toBe(0);
    const saved = await save(state);
    const reads = calculate.mock.calls.length;
    expect(await save(state)).toEqual(saved);
    expect(calculate).toHaveBeenCalledTimes(reads);
    expect(connector.createCalls).toBe(1);
  } finally { journal.close(); }
});

it('permits a newly reviewed payload after a preflight totals mismatch', async () => {
  const c = config(); c.orderSavingEnabled = true;
  const connector = new DemoConnector(), order = await prepared();
  const totals = await connector.calculateTotals(order);
  const journal = new WriteJournal(':memory:'); await journal.init();
  const state: Conversation = { orderId: 'mismatch', revision: 1, status: 'ready', draft: draft(), policy: '', prepared: order, totals: { ...totals, gross: totals.gross + 1 } };
  try {
    const save = orderCreator(c, connector, journal);
    await expect(save(state)).rejects.toMatchObject({ needsReview: true });
    expect(connector.createCalls).toBe(0);
    await save({ ...state, revision: 2, totals });
    expect(connector.createCalls).toBe(1);
  } finally { journal.close(); }
});

it('keeps a failed read confirmable, but invalidates a summary whose totals changed', async () => {
  const c = config(); c.orderSavingEnabled = true;
  const store = new TelegramStore(':memory:', 'preflight'); await store.init();
  let mid = 100;
  const order = await prepared();
  const engine = stubEngine();
  engine.turn.mockImplementation(async input => { const previous = input.request ?? input.fresh('order'); return { text: 'Summary', reply: '', locale: 'it', order: { ...previous, status: 'ready', revision: previous.revision + 1, prepared: order, totals: { net: 1, vat: 0, gross: 1 } } }; });
  const save = vi.fn().mockRejectedValueOnce(new PreflightFailed()).mockRejectedValueOnce(new PreflightFailed(true));
  const ctl = new TelegramController(c, 'bot', store, engine, async () => ({ message_id: mid++ }), undefined, save, async () => ({ message_id: 500 }));
  try {
    await ctl.handle(message(1, '@bot ordine Test'));
    await ctl.handle(button(2, 100, 'save:u1:1'));
    expect((await store.order('u1'))?.status).toBe('ready');
    await ctl.handle(button(3, 101, 'save:u1:1'));
    expect(await store.order('u1')).toMatchObject({ status: 'new', revision: 2 });
    expect((await store.order('u1'))?.prepared).toBeUndefined();
    await ctl.handle(button(4, 100, 'save:u1:1'));
    expect(save).toHaveBeenCalledTimes(2);
  } finally { store.close(); }
});

it('renders every PDF page for the general reader when no templates are configured', async () => {
  const c = config();
  const data = mixedPdf();
  const read = vi.fn(async () => '2 bottles; deliver to another address');
  const media = createMediaReader(c, new DemoConnector(), async () => data, { documents: createVisionDocumentProvider({ read }) });
  const result = await media({ updateId: 1, groupId: c.channel.groupId, senderId: '5', messageId: 1, text: '', attachments: [{ kind: 'pdf', fileId: 'pdf', mimeType: 'application/pdf' }] });
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenCalledWith([{ data: expect.any(Buffer), mimeType: 'image/png' }], false);
  expect(result.text).toContain('another address');
});

it('rejects overlong document readings rather than accepting a truncated order', async () => {
  const c = config();
  const read = createMediaReader(c, new DemoConnector(), async () => mixedPdf(), { documents: createVisionDocumentProvider({ read: async () => 'A'.repeat(8000) + '\nDelivery address and discount' }) });
  await expect(read({ updateId: 1, groupId: c.channel.groupId, senderId: '5', messageId: 1, text: '', attachments: [{ kind: 'pdf', fileId: 'pdf', mimeType: 'application/pdf' }] }, 'en')).rejects.toThrow('No draft updated');
});

it('rejects a model reading stopped at its output limit', async () => {
  const agent = { generate: async () => ({ text: 'Partial order', finishReason: 'length' }) } as unknown as Agent;
  await expect(modelReader(agent)([{ data: new Uint8Array([1]), mimeType: 'application/pdf' }])).rejects.toThrow('Incomplete');
});

it('persists the agent\'s reply language through restart, confirmation buttons and cancellation', async () => {
  const c = config(); c.channel.respondToAllMessages = true;
  const store = new TelegramStore(':memory:', 'language'); await store.init();
  let mid = 100;
  const engine = stubEngine('ready', 'Summary', 'customer');
  engine.turn.mockImplementation(async input => { const previous = input.fresh('customer'); return { text: 'Summary', reply: '', locale: 'en', order: { ...previous, status: 'ready', revision: 1 } }; });
  const send = vi.fn(async (_text: string, _reply: number, _keyboard?: unknown) => ({ message_id: mid++ }));
  try {
    await new TelegramController(c, 'bot', store, engine, send, async () => 'Created').handle(message(1, 'Please create a customer'));
    expect(send.mock.calls[0]?.[2]).toMatchObject({ inline_keyboard: [[{ text: '✅ Confirm and save' }, { text: '❌ Cancel' }]] });
    await new TelegramController(c, 'bot', store, engine, send).handle(button(2, 100, 'cancel:u1:1'));
    expect(send.mock.calls.at(-1)?.[0]).toContain('Cancelled.');
    expect(await store.locale()).toBe('en');
  } finally { store.close(); }
});

it('renders customer validation, saved results and order labels in the resolved language', async () => {
  const c = config(); c.locale = 'en'; c.clients.requiredFields = []; c.clients.sdiCountries = [];
  expect(customerDetails(draft(), c).missing).toEqual(['name']);
  const { id: _id, ...newClient } = (await new DemoConnector().listClients())[0]!;
  const journal = new WriteJournal(':memory:'); await journal.init();
  try {
    const creator = customerCreator(config(), { listClients: async () => [], createClient: async client => ({ ...client, id: 999 }) }, journal);
    const text = await creator({ orderId: 'en', kind: 'customer', locale: 'en', revision: 1, status: 'ready', draft: { ...draft(), newClient }, policy: '' });
    expect(text).toContain('Customer created');
    expect(customerPreview({ ...newClient, notes: 'Test' }, false)).toContain('📝 Notes');
    const preview = orderPreview(await prepared(), { net: 1, vat: 0.22, gross: 1.22 }, false);
    expect(preview).toContain('VAT 22%');
    expect(preview).not.toContain('IVA');
  } finally { journal.close(); }
});
