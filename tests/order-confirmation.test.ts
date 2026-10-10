import { expect, it, vi } from 'vitest';
import { config, draft, message, prepared, press, stubEngine } from './helpers.js';
import { DemoConnector } from '../src/connector/demo.js';
import { WriteJournal } from '../src/storage/write-journal.js';
import { orderCreator } from '../src/channel/order.js';
import { TelegramController, policyFingerprint } from '../src/channel/controller.js';
import { TelegramStore, type Conversation } from '../src/channel/store.js';

it('saves the reviewed payload once and blocks changed payload retries', async () => {
 const c=config();c.orderSavingEnabled=true;
 const connector=new DemoConnector();const journal=new WriteJournal(':memory:');await journal.init();
 try {
  const order=await prepared();const totals=await connector.calculateTotals(order);
  const state:Conversation={orderId:'test',revision:1,status:'ready',draft:draft(),policy:policyFingerprint(c),prepared:order,totals};
  const save=orderCreator(c,connector,journal);
  await expect(save({...state,status:'suspended'})).rejects.toThrow();
  const saved=await save(state);expect(Number(saved.id)).toBeGreaterThan(0);
  expect(await save(state)).toEqual(saved);expect(connector.createCalls).toBe(1);
  await expect(save({...state,prepared:{...order,notes:'Changed'}})).rejects.toThrow();
  expect(connector.createCalls).toBe(1);
 } finally {journal.close();}
});

it('rejects stale confirmations and does not re-save or resend after uncertain PDF delivery', async () => {
 const c=config();c.orderSavingEnabled=true;const store=new TelegramStore(':memory:','orders');await store.init();
 let mid=100;
 const send=vi.fn(async()=>({message_id:mid++}));
 const save=vi.fn(async()=>({id:'321',number:'42'}));
 const pdf=vi.fn(async()=>{throw new Error('timeout');});
 const engine=stubEngine();
 engine.turn.mockImplementation(async input=>{const p=input.request??input.fresh('order');return {text:'Summary',reply:'',locale:'it',order:{...p,revision:p.revision+1,status:'ready' as const,prepared:await prepared(),totals:{net:29.6,vat:6.51,gross:36.11}}};});
 const controller=new TelegramController(c,'bot',store,engine,send,undefined,save,pdf);
 try {
  await controller.handle(message(1,'@bot ordine two'));
  await controller.handle(message(2,'make three',100));
  await controller.handle(press(3,'save:u1:1',100));expect(save).not.toHaveBeenCalled();
  await expect(controller.handle(press(4,'save:u1:2',101))).rejects.toThrow('timeout');
  expect((await store.order('u1'))?.status).toBe('saved');expect(save).toHaveBeenCalledTimes(1);
  await expect(controller.handle(press(4,'save:u1:2',101))).rejects.toThrow(/uncertain/);
  expect(pdf).toHaveBeenCalledTimes(1);expect(save).toHaveBeenCalledTimes(1);
  await store.sent(4,500); // Operator verified the document arrived.
  await controller.handle(press(4,'save:u1:2',101));
  await controller.handle(press(5,'save:u1:3',500));expect(save).toHaveBeenCalledTimes(1);
 }finally{store.close();}
});
