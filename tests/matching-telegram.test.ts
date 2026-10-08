import { expect, it, vi } from 'vitest';
import { LibSQLStore } from '@mastra/libsql';
import { createConversationEngine } from '../src/telegram/engine.js';
import { TelegramController } from '../src/telegram/controller.js';
import { TelegramStore } from '../src/telegram/store.js';
import { DemoConnector } from '../src/connector/demo.js';
import { matchingConfigSchema } from '../src/matching/config.js';
import type { SelectionResult } from '../src/matching/types.js';
import type { SelectMany } from '../src/matching/resolver.js';
import { config, draft } from './helpers.js';

const on = matchingConfigSchema.parse({ mode: 'on' });
const judge: SelectMany = async requests => requests.map(r => ({ status: 'matched', selectedId: r.kind === 'client' ? 201 : 101,
  evidence: { requestHash: 'test', promptVersion: 'test', retrieval: r.retrieval, elapsedMs: 0 } } satisfies SelectionResult));

it('preserves pre-router operator text, stores validated IDs, and re-resolves clarification turns', async () => {
  const c = config(); c.telegram.respondToAllMessages = true;
  const store = new TelegramStore(':memory:', 'jev-routing'); await store.init();
  const storage = new LibSQLStore({ id: 'jev-routing', url: ':memory:' });
  const selectMany = vi.fn(judge);
  const extract = vi.fn().mockResolvedValueOnce({ ...draft(), clientId: 202, lines: [{ query: 'small pebble wash', productId: 102 }] })
    .mockResolvedValue({ ...draft(), clientId: 202, lines: [{ query: 'small pebble wash', productId: 102, quantity: 2 }] });
  const engine = createConversationEngine(c, new DemoConnector(), storage, 'demo', extract, undefined, { config: on, selectMany });
  engine.route = async () => ({ action: 'order', text: 'Paraphrased request with the wrong ID', locale: 'en' });
  let id = 100;
  const controller = new TelegramController(c, 'bot', store, engine, async () => ({ message_id: id++ }));
  const message = (updateId: number, text: string, replyTo?: number) => ({ update_id: updateId, message: { message_id: updateId, text, from: { id: 5, is_bot: false }, chat: { id: Number(c.telegram.groupId), type: 'supergroup' }, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) } });
  try {
    const original = 'The example shop wants the small pebble wash';
    await controller.handle(message(1, original));
    expect(selectMany.mock.calls[0]![0].every(r => r.context === original)).toBe(true);
    const first = await store.order('u1');
    expect(first?.status).toBe('suspended');
    expect(first?.draft.lines[0]?.productId).toBe(101);
    engine.route = async () => ({ action: 'continue', text: 'quantity two', locale: 'en' });
    await controller.handle(message(2, 'Make it two', 100));
    const next = await store.order('u1');
    expect(next?.status).toBe('ready');
    expect(next?.prepared?.client.id).toBe(201);
    expect(next?.draft.lines[0]?.productId).toBe(101);
    expect(next?.matchingDecisions).toHaveLength(2);
    expect(selectMany.mock.calls[1]![0][0]?.context).toContain('Make it two');
    const calls = extract.mock.calls.length;
    await controller.handle(message(3, 'line 1: 101', 101));
    expect(extract).toHaveBeenCalledTimes(calls);
    expect((await store.order('u1'))?.draft.lines[0]?.productId).toBe(101);
  } finally { await engine.shutdown(); store.close(); await storage.close(); }
}, 20000);

it('enabling authoritative matching invalidates confirmations prepared under the legacy policy', async () => {
  const c = config(); c.orderSavingEnabled = true;
  const store = new TelegramStore(':memory:', 'jev-policy'); await store.init();
  const { prepared } = await import('./helpers.js');
  const process: import('../src/telegram/controller.js').ConversationEngine = async (_text, previous) => ({
    conversation: { ...previous, revision: previous.revision + 1, status: 'ready', prepared: await prepared(), totals: { net: 1, vat: 0, gross: 1 } }, text: 'Summary',
  });
  const send = vi.fn(async () => ({ message_id: 100 })); const save = vi.fn();
  const message = (id: number, text: string, reply?: number) => ({ update_id: id, message: { message_id: id, from: { id: 5, is_bot: false }, chat: { id: Number(c.telegram.groupId), type: 'supergroup' }, text, ...(reply ? { reply_to_message: { message_id: reply } } : {}) } });
  try {
    await new TelegramController(c, 'bot', store, process, send, undefined, save, async () => ({ message_id: 200 })).handle(message(1, '/order two'));
    process.matchingPolicy = 'jev-identities-v1:test';
    await new TelegramController(c, 'bot', store, process, send, undefined, save, async () => ({ message_id: 200 })).handle(message(2, '/confirmorder', 100));
    expect(save).not.toHaveBeenCalled();
    expect((await store.order('u1'))?.status).toBe('ready');
  } finally { store.close(); }
});

it('finishes a customer request without offering creation when an existing customer is explicitly selected', async () => {
  const c = config();
  const storage = new LibSQLStore({ id: 'jev-existing-customer', url: ':memory:' });
  const extract = vi.fn();
  const engine = createConversationEngine(c, new DemoConnector(), storage, 'demo', extract, undefined, { config: on, selectMany: judge });
  try {
    const result = await engine('client: 201', { orderId: 'existing', kind: 'customer', revision: 1, status: 'suspended', policy: c.policyVersion, questions: '', draft: { ...draft(), newClient: { name: 'Example shop' } } });
    expect(result.conversation.status).toBe('reviewed');
    expect(result.conversation.draft.clientId).toBe(201);
    expect(result.conversation.draft.newClient).toBeUndefined();
    expect(result.text).toContain('201');
    expect(extract).not.toHaveBeenCalled();
  } finally { await engine.shutdown(); await storage.close(); }
});
