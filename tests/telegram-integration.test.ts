import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TelegramController } from '../src/telegram/controller.js';
import { TelegramStore } from '../src/telegram/store.js';
import { config } from './helpers.js';
function update(id: number, text: string, reply?: number, sender = 5) {
  return { update_id: id, message: { message_id: id, chat: { id: -1000000000001, type: 'supergroup' }, from: { id: sender, is_bot: false }, text, reply_to_message: reply ? { message_id: reply } : undefined } };
}
it('persists routing and skips replayed messages after a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tg-tests-'));
  const url = `file:${join(dir, 'state.db')}`;
  let store = new TelegramStore(url, 'demo');
  const engine = vi.fn(async (_text, previous) => ({ conversation: { ...previous, revision: previous.revision + 1, status: 'ready' as const }, text: 'Preview' }));
  const send = vi.fn(async (_text: string, _reply: number) => ({ message_id: 100 }));
  try {
    await store.init();
    await new TelegramController(config(), 'bot', store, engine, send).handle(update(1, '/order two bottles'));
    store.close(); store = new TelegramStore(url, 'demo'); await store.init();
    const controller = new TelegramController(config(), 'bot', store, engine, send);
    await controller.handle(update(1, '/order two bottles'));
    expect(engine).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
    await controller.handle(update(2, 'make that three', 100, 7));
    expect(engine.mock.calls[1]![1].orderId).toBe('u1');
    expect((await store.order('u1'))?.revision).toBe(2);
    expect(await store.offset()).toBe(3);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
it('does not rerun the model or blindly resend after an uncertain send', async () => {
  const store = new TelegramStore(':memory:', 'demo'); await store.init();
  const engine = vi.fn(async (_text, previous) => ({ conversation: { ...previous, revision: 1, status: 'ready' as const }, text: 'Preview' }));
  const send = vi.fn().mockRejectedValue(new Error('timeout'));
  const controller = new TelegramController(config(), 'bot', store, engine, send);
  try {
    await expect(controller.handle(update(1, '/order item'))).rejects.toThrow();
    await expect(controller.handle(update(1, '/order item'))).rejects.toThrow(/uncertain/);
    expect(engine).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
    await store.sent(1, 100); // Operator has verified delivery in the group.
    await controller.handle(update(1, '/order item'));
    expect(await store.offset()).toBe(2);
  } finally { store.close(); }
});
it('blocks a second active order and rejects stale reviews', async () => {
  const store = new TelegramStore(':memory:', 'demo'); await store.init();
  let messageId = 100;
  const engine = vi.fn(async (_text, previous) => ({ conversation: { ...previous, revision: previous.revision + 1, status: 'ready' as const }, text: 'Preview' }));
  const send = vi.fn(async (_text: string, _reply: number) => ({ message_id: messageId++ }));
  const controller = new TelegramController(config(), 'bot', store, engine, send);
  try {
    await controller.handle(update(1, '/order first'));
    await controller.handle(update(2, '/order second'));
    await controller.handle(update(3, 'edit first', 100, 7));
    expect(engine.mock.calls[1]![1].orderId).toBe('u1');
    await controller.handle(update(4, '/review', 100));
    expect((await store.order('u1'))?.status).toBe('ready');
    expect(engine).toHaveBeenCalledTimes(2);
    await controller.handle(update(5, '/review', 102));
    expect((await store.order('u1'))?.status).toBe('reviewed');
    expect(await store.order('u2')).toBeUndefined();
  } finally { store.close(); }
});

it('runs actual Mastra clarification and resumes it with a colleague correction', async () => {
  const { LibSQLStore } = await import('@mastra/libsql');
  const { DemoConnector } = await import('../src/connector/demo.js');
  const { createConversationEngine } = await import('../src/telegram/engine.js');
  const { draftSchema } = await import('../src/domain/types.js');
  const storage = new LibSQLStore({ id: 'tg-engine', url: ':memory:' });
  const store = new TelegramStore(':memory:', 'engine'); await store.init();
  let messageId = 100;
  const extraction = vi.fn()
    .mockResolvedValueOnce(draftSchema.parse({ clientQuery: 'Example Studio', lines: [{ query: 'Pebble 250', quantity: 2 }] }))
    .mockResolvedValueOnce(draftSchema.parse({ clientQuery: 'Example Studio', lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }], shippingPrice: 8 }));
  const connector = new DemoConnector();
  const send = vi.fn(async (_text: string, _reply: number) => ({ message_id: messageId++ }));
  try {
    const engine = createConversationEngine(config(), connector, storage, 'demo', extraction, async () => ({ 'lines.0': 'Quale variante di Pebble?', shippingPrice: 'Qual è il costo di consegna?' }));
    const controller = new TelegramController(config(), 'bot', store, engine, send);
    await controller.handle(update(1, '/order two Pebble 250 for Example Studio'));
    const first = await store.order('u1');
    expect(first?.status).toBe('suspended');
    expect(send.mock.calls[0]![0]).toContain('Quale variante di Pebble?\nPebble hand wash 250 ml\nPebble hand wash 250 ml sample');
    expect(first?.questions).toContain('shippingPrice');
    await controller.handle(update(2, 'regular, shipping eight', 100, 7));
    expect((await store.order('u1'))?.status).toBe('ready');
    expect((await store.order('u1'))?.runId).toBe(first?.runId);
    expect(send.mock.calls[1]![0]).toContain('Anteprima ordine');
    expect(send.mock.calls[1]![0]).not.toContain('Consegna:');
    expect(extraction.mock.calls[1]![0]).toContain('currentDraft');
    expect(connector.createCalls).toBe(0);
  } finally { store.close(); await storage.close(); }
});
it('attaches colleague details to the shared active request', async () => {
 const store = new TelegramStore(':memory:','pending');await store.init();
 const engine=vi.fn(async (_text, previous)=>({conversation:{...previous,revision:1,status:'ready' as const},text:'Summary'}));
 const send=vi.fn(async()=>({message_id:100}));
 const controller=new TelegramController(config(),'bot',store,engine,send);
 try {
  await controller.handle(update(1,'/ordine'));
  await controller.handle(update(2,'crea ordine per Cliente Test: 5 Sapone Lunara',undefined,7));
  expect(engine).toHaveBeenCalledTimes(1);
  await controller.handle(update(3,'crea ordine per Cliente Test: 5 Sapone Lunara'));
  expect(engine.mock.calls[0]![1].orderId).toBe('u1');
  expect(engine.mock.calls[0]![1].kind).toBeUndefined();
 }finally{store.close();}
});
it('cancels the latest request on its own, or the replied-to one, and stops using it', async () => {
 const store = new TelegramStore(':memory:','cancel');await store.init();
 let messageId=100;
 const engine=vi.fn(async (_text, previous)=>({conversation:{...previous,revision:previous.revision+1,status:'ready' as const},text:'Summary'}));
 const send=vi.fn(async(_text:string,_reply:number)=>({message_id:messageId++}));
 const controller=new TelegramController(config(),'bot',store,engine,send);
 try {
  await controller.handle(update(1,'/ordine'));
  await controller.handle(update(2,'/annulla'));
  expect((await store.order('u1'))?.status).toBe('cancelled');
  expect(send.mock.calls[1]![0]).toContain('Annullato');
  await controller.handle(update(3,'Cliente Test: 5 Sapone Lunara'));
  expect(engine).not.toHaveBeenCalled();
  await controller.handle(update(4,'/ordine Cliente Test, 5 Sapone Lunara'));
  await controller.handle(update(5,'/annulla@bot',102));
  expect((await store.order('u4'))?.status).toBe('cancelled');
  await controller.handle(update(6,'make it 6',102));
  expect(engine).toHaveBeenCalledTimes(1);
  expect(send.mock.calls.at(-1)![0]).toContain('annullata');
  await controller.handle(update(7,'/annulla'));
  expect(send.mock.calls.at(-1)![0]).toContain('Nessuna richiesta aperta');
 }finally{store.close();}
});
it('keeps the existing request when a second start command is sent', async () => {
 const store = new TelegramStore(':memory:','pending');await store.init();
 const c=config();c.telegram.respondToAllMessages=true;
 const engine=vi.fn(async (_text, previous)=>({conversation:{...previous,revision:1,status:'ready' as const},text:'Summary'}));
 const send=vi.fn(async()=>({message_id:100}));
 const controller=new TelegramController(c,'bot',store,engine,send);
 try {
  await controller.handle(update(1,'/cliente'));
  await controller.handle(update(2,'/ordine'));
  await controller.handle(update(3,'Cliente Test: 5 Sapone Lunara'));
  expect(engine.mock.calls[0]![1].orderId).toBe('u1');
  expect(engine.mock.calls[0]![1].kind).toBe('customer');
 }finally{store.close();}
});
