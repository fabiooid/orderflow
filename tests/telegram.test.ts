import { expect, it, vi } from 'vitest';
import { normalizeCallback, normalizeMessage } from '../src/telegram/adapter.js';
import { commandAction, routeMessage, type IntentRouter, type RoutingContext } from '../src/telegram/routing.js';
import type { Conversation } from '../src/telegram/store.js';
import { draftSchema } from '../src/domain/types.js';
import { config } from './helpers.js';
const update = () => ({ update_id: 1, message: { message_id: 2, chat: { id: -1000000000001, type: 'supergroup' }, from: { id: 5, is_bot: false }, text: '/order two notebooks' } });
const event = () => normalizeMessage(update(), config())!;
const conv = (orderId: string, revision: number): Conversation => ({ orderId, revision, status: 'ready', draft: draftSchema.parse({}), questions: '', policy: '' });
const ctx = (extra: Partial<RoutingContext> = {}): RoutingContext => ({ config: config(), botUsername: 'demo_bot', ...extra });

it('accepts any human member of the configured group, rejects other chats and bots', () => {
  expect(normalizeMessage(update(), config())?.senderId).toBe('5');
  const other = update(); other.message.chat.id = -999;
  expect(normalizeMessage(other, config())).toBeNull();
  const bot = update(); bot.message.from.is_bot = true;
  expect(normalizeMessage(bot, config())).toBeNull();
});
it('routes replies by message reference, not by whoever last spoke', async () => {
  expect(await routeMessage(event(), ctx())).toMatchObject({ kind: 'start', customer: false, text: 'two notebooks' });
  const link = { orderId: 'first', revision: 1 };
  expect(await routeMessage({ ...event(), text: 'make that 12', replyTo: 10 }, ctx({ link, linked: conv('first', 1), active: conv('second', 2) })))
    .toMatchObject({ kind: 'edit', target: link });
  expect((await routeMessage({ ...event(), text: 'make that 12' }, ctx())).kind).toBe('ignore');
  expect((await routeMessage({ ...event(), text: '/order@other_bot two' }, ctx())).kind).toBe('ignore');
});
it('never sends a reply to an older summary through the model', async () => {
  const model = vi.fn();
  const link = { orderId: 'first', revision: 1 };
  expect(await routeMessage({ ...event(), text: 'make that 12', replyTo: 10 }, ctx({ link, linked: conv('first', 2), model })))
    .toMatchObject({ kind: 'edit', target: link });
  expect(model).not.toHaveBeenCalled();
});
it('sends only addressed messages to the model unless configured to read everything', async () => {
  const model = vi.fn(async () => ({ action: 'answer' as const, text: 'Two sizes.' }));
  expect(await routeMessage({ ...event(), text: '@demo_bot quali varianti di Sapone Zenzero abbiamo?' }, ctx({ model }))).toEqual({ kind: 'answer', text: 'Two sizes.' });
  expect((await routeMessage({ ...event(), text: '@other_bot domanda' }, ctx({ model }))).kind).toBe('ignore');
  expect((await routeMessage({ ...event(), text: 'Quali formati abbiamo?' }, ctx({ model }))).kind).toBe('ignore');
  expect(model).toHaveBeenCalledTimes(1);
  const c = config(); c.telegram.respondToAllMessages = true;
  expect((await routeMessage({ ...event(), text: 'Quali formati abbiamo?' }, ctx({ config: c, model }))).kind).toBe('answer');
  expect((await routeMessage({ ...event(), text: '/confirmcustomer' }, ctx({ config: c, model }))).kind).toBe('ignore');
});
it('gives the model the active request for plain follow-ups and maps its intents to actions', async () => {
  const active = conv('u1', 3);
  const model = vi.fn<IntentRouter>(async () => ({ action: 'continue', text: 'three bottles' }));
  expect(await routeMessage({ ...event(), text: 'make it three' }, ctx({ active, model }))).toEqual({ kind: 'edit', target: { orderId: 'u1', revision: 3 }, text: 'three bottles' });
  expect(model.mock.calls[0]).toEqual(['make it three', '5', active, 'it']);
  model.mockResolvedValueOnce({ action: 'cancel', text: '' });
  expect(await routeMessage({ ...event(), text: 'lascia stare' }, ctx({ active, model }))).toEqual({ kind: 'cancel', target: { orderId: 'u1', revision: 3 } });
  model.mockRejectedValueOnce(new Error('provider down'));
  expect((await routeMessage({ ...event(), text: 'make it four' }, ctx({ active, model }))).kind).toBe('answer');
});
it('accepts Italian customer and order commands with optional bot suffix', () => {
  for (const text of ['/cliente Mario', '/cliente@demo_bot Mario']) expect(commandAction(text, config(), 'demo_bot')).toEqual({ kind: 'start', customer: true, text: 'Mario' });
  for (const text of ['/ordine due saponi', '/ordine@demo_bot due saponi']) expect(commandAction(text, config(), 'demo_bot')).toEqual({ kind: 'start', customer: false, text: 'due saponi' });
  expect(commandAction('/cliente@other_bot Mario', config(), 'demo_bot').kind).toBe('ignore');
});
it('routes cancel to the replied-to request or the active one, and confirmations only to a replied-to summary', () => {
  const link = { orderId: 'first', revision: 1 };
  expect(commandAction('/annulla', config(), 'demo_bot', link)).toEqual({ kind: 'cancel', target: link });
  expect(commandAction('/cancel@demo_bot', config(), 'demo_bot')).toEqual({ kind: 'cancel', target: undefined });
  expect(commandAction('/annulla@other_bot', config(), 'demo_bot', link).kind).toBe('ignore');
  expect(commandAction('/confermaordine', config(), 'demo_bot', link)).toEqual({ kind: 'confirmOrder', target: link });
  expect(commandAction('/confermaordine', config(), 'demo_bot').kind).toBe('ignore');
  expect(commandAction('/unknown', config(), 'demo_bot', link).kind).toBe('ignore');
});
it('treats a command with trailing text in a reply to a summary as an edit', () => {
  const link = { orderId: 'first', revision: 1 };
  for (const text of ['/annulla scusa, sbagliato', '/reopen cambia la quantità', '/confermaordine@demo_bot ma con 3 pezzi'])
    expect(commandAction(text, config(), 'demo_bot', link)).toEqual({ kind: 'edit', target: link, text });
  expect(commandAction('/reopen cambia la quantità', config(), 'demo_bot').kind).toBe('ignore');
});
it('without a model, starts only explicit natural-language order requests', async () => {
  const c = config(); c.telegram.respondToAllMessages = true;
  expect(await routeMessage({ ...event(), text: 'crea ordine per Cliente Test: 5 Sapone Mani Lavanda 250ml' }, ctx({ config: c })))
    .toMatchObject({ kind: 'start', customer: false });
  expect((await routeMessage({ ...event(), text: 'Quali saponi abbiamo?' }, ctx({ config: c }))).kind).toBe('ignore');
});
it('turns buttons into typed actions bound to their revision', () => {
  const tap = { update_id: 9, callback_query: { id: 'cb', from: { id: 7, is_bot: false }, data: 'save:u1:2', message: { message_id: 100, chat: { id: -1000000000001, type: 'supergroup' } } } };
  expect(normalizeCallback(tap, config())).toMatchObject({ action: { kind: 'confirmOrder', target: { orderId: 'u1', revision: 2 } }, event: { senderId: '7', replyTo: 100 } });
  expect(normalizeCallback({ ...tap, callback_query: { ...tap.callback_query, data: 'delete:u1:2' } }, config())).toBeUndefined();
});
