import { expect, it, vi } from 'vitest';
import { config, draft, prepared } from './helpers.js';
import { TelegramStore, type Conversation } from '../src/telegram/store.js';
import { TelegramController, type ConversationEngine } from '../src/telegram/controller.js';
import { orderCreator } from '../src/telegram/order.js';
import { customerCreator, customerDetails } from '../src/telegram/customer.js';
import { WriteJournal, PreflightFailed } from '../src/storage/write-journal.js';
import { DemoConnector } from '../src/connector/demo.js';
import { createMediaReader, modelReader } from '../src/telegram/media.js';
import type { Agent } from '@mastra/core/agent';
import { searchCatalogue } from '../src/domain/matching.js';
import { prepareOrder } from '../src/domain/prepare.js';
import { customerPreview, orderPreview } from '../src/telegram/preview.js';

const chat = { id: Number(config().telegram.groupId), type: 'supergroup' };
const from = { id: 5, is_bot: false };
const message = (id: number, text: string) => ({ update_id: id, message: { message_id: id, chat, from, text } });
const photo = (id: number) => ({ update_id: id, message: { message_id: id, chat, from, photo: [{ file_id: 'test' }] } });
const button = (id: number, messageId: number, data: string) => ({ update_id: id, callback_query: { id: `cb${id}`, from, data, message: { message_id: messageId, chat } } });

it('blocks edits, cancellation and repeat creation after an uncertain customer write', async () => {
  const store = new TelegramStore(':memory:', 'customer'); await store.init();
  let mid = 100;
  const engine = vi.fn(async (_text: string, previous: Conversation) => ({ conversation: { ...previous, status: 'ready' as const, revision: previous.revision + 1 }, text: 'Summary' }));
  const create = vi.fn(async () => { throw new Error('Response lost after remote save'); });
  const send = vi.fn(async (_text: string) => ({ message_id: mid++ }));
  const ctl = new TelegramController(config(), 'bot', store, engine, send, create);
  try {
    await ctl.handle(message(1, '/cliente Test'));
    await ctl.handle(button(2, 100, 'customer:u1:1'));
    expect((await store.order('u1'))?.status).toBe('saving');
    await ctl.handle(message(3, 'change the name'));
    await ctl.handle(button(4, 100, 'customer:u1:1'));
    await ctl.handle(message(5, '/annulla'));
    await ctl.handle(message(6, '/cliente Another'));
    expect((await store.order('u1'))?.status).toBe('saving');
    expect(engine).toHaveBeenCalledTimes(1);
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
  const state: Conversation = { orderId: 'retry', revision: 1, status: 'ready', draft: draft(), questions: '', policy: '', prepared: order, totals };
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
  const state: Conversation = { orderId: 'mismatch', revision: 1, status: 'ready', draft: draft(), questions: '', policy: '', prepared: order, totals: { ...totals, gross: totals.gross + 1 } };
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
  const engine: ConversationEngine = async (_text, previous) => ({ conversation: { ...previous, status: 'ready', revision: previous.revision + 1, prepared: await prepared(), totals: { net: 1, vat: 0, gross: 1 } }, text: 'Summary' });
  const save = vi.fn().mockRejectedValueOnce(new PreflightFailed()).mockRejectedValueOnce(new PreflightFailed(true));
  const ctl = new TelegramController(c, 'bot', store, engine, async () => ({ message_id: mid++ }), undefined, save, async () => ({ message_id: 500 }));
  try {
    await ctl.handle(message(1, '/ordine Test'));
    await ctl.handle(button(2, 100, 'save:u1:1'));
    expect((await store.order('u1'))?.status).toBe('ready');
    await ctl.handle(button(3, 101, 'save:u1:1'));
    expect(await store.order('u1')).toMatchObject({ status: 'new', revision: 2 });
    expect((await store.order('u1'))?.prepared).toBeUndefined();
    await ctl.handle(button(4, 100, 'save:u1:1'));
    expect(save).toHaveBeenCalledTimes(2);
  } finally { store.close(); }
});

