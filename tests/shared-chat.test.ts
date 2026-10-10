import {expect,it,vi} from 'vitest';
import {TelegramController} from '../src/channel/controller.js';
import {TelegramStore} from '../src/channel/store.js';
import {config,message,prepared,press,stubEngine} from './helpers.js';
import type {Keyboard} from '../src/channels/telegram/api.js';

/** A stub agent whose turns prepare a ready order, except a question, which it answers without touching the request. */
async function orderingEngine(){
 const order=await prepared();
 const engine={...stubEngine(),record:vi.fn(async()=>{})};
 engine.turn.mockImplementation(async input=>{
  if(input.operatorText==='question')return {text:'Catalogue answer',reply:'',locale:'it'};
  const p=input.request??input.fresh('order');
  return {text:'Summary',reply:'',locale:'it',order:{...p,revision:p.revision+1,status:'ready' as const,prepared:order,totals:{net:1,vat:0,gross:1}}};
 });
 return engine;
}
it('shares context with colleagues, preserves drafts during questions and saves only a current button once',async()=>{
 const c=config(); c.orderSavingEnabled=true;c.channel.respondToAllMessages=true;
 const store=new TelegramStore(':memory:','shared');await store.init();
 const engine=await orderingEngine();
 let mid=100;
 const send=vi.fn(async(_text:string,_reply:number,_keyboard?:Keyboard)=>({message_id:mid++}));
 const save=vi.fn(async()=>({id:321,number:'42'}));const pdf=vi.fn(async()=>({message_id:500}));
 const controller=new TelegramController(c,'bot',store,engine,send,undefined,save,pdf);
 try {
  await controller.handle(message(1,'start'));
  expect(send.mock.calls[0]?.[2]?.inline_keyboard[0]?.[0]?.callback_data).toBe('save:u1:1');
  await controller.handle(message(2,'question',undefined,7));
  expect((await store.order('u1'))?.revision).toBe(1);
  expect(engine.turn.mock.calls[1]?.[0].request?.orderId).toBe('u1');
  await controller.handle(message(3,'make it three',undefined,7));
  expect(engine.turn.mock.calls[2]?.[0]).toMatchObject({operatorText:'make it three',request:{orderId:'u1'}});
  await controller.handle(press(4,'save:u1:1',100,7));expect(save).not.toHaveBeenCalled();
  const otherChat=press(5,'save:u1:2',102,7);otherChat.callback_query.message.chat.id=99;
  await controller.handle(otherChat);expect(save).not.toHaveBeenCalled();
  await controller.handle(press(6,'save:u1:2',102,7));expect(save).toHaveBeenCalledTimes(1);expect(pdf).toHaveBeenCalledTimes(1);
  await controller.handle(press(6,'save:u1:2',102,7));expect(save).toHaveBeenCalledTimes(1);
  expect(await store.activeRequest()).toBeUndefined();
 }finally{store.close();}
});
it('accepts natural cancellation without writing a customer or order',async()=>{
 const c=config();c.channel.respondToAllMessages=true;
 const store=new TelegramStore(':memory:','cancel');await store.init();
 const engine=stubEngine('suspended','Which size?');
 const controller=new TelegramController(c,'bot',store,engine,async()=>({message_id:100}));
 try{
  await controller.handle(message(1,'ordine two'));
  engine.turn.mockResolvedValueOnce({text:'',reply:'',locale:'it',cancel:true});
  await controller.handle(message(2,'annulla questo ordine',undefined,7));
  expect((await store.order('u1'))?.status).toBe('cancelled');expect(engine.turn).toHaveBeenCalledTimes(2);
 }finally{store.close();}
});
it('resumes a saved callback delivery after restart without repeating the write',async()=>{
 const c=config();c.orderSavingEnabled=true;
 const store=new TelegramStore(':memory:','replay');await store.init();
 const engine=await orderingEngine();
 let mid=100;const send=async()=>({message_id:mid++});
 const save=vi.fn(async()=>({id:321,number:'42'}));
 const pdf=vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({message_id:500});
 const controller=new TelegramController(c,'bot',store,engine,send,undefined,save,pdf);
 try{
  await controller.handle(message(1,'@bot ordine two'));
  const click=press(2,'save:u1:1',100);
  await expect(controller.handle(click)).rejects.toThrow('timeout');
  await store.retrySend(2); // Operator checked that the PDF did not arrive.
  await controller.handle(click);
  expect(save).toHaveBeenCalledTimes(1);expect(pdf).toHaveBeenCalledTimes(2);expect(await store.offset()).toBe(3);
 }finally{store.close();}
});
it('does not send unaddressed group chatter to the agent when respondToAllMessages is off',async()=>{
 const store=new TelegramStore(':memory:','quiet');await store.init();
 const engine=stubEngine();engine.turn.mockResolvedValue({text:'Hi',reply:'',locale:'it'});
 const send=vi.fn(async()=>({message_id:100}));
 const controller=new TelegramController(config(),'bot',store,engine,send);
 try{
  await controller.handle(message(1,'lunch at noon?'));expect(engine.turn).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
  await controller.handle(message(2,'@bot quali formati abbiamo?'));expect(engine.turn).toHaveBeenCalledTimes(1);expect(send).toHaveBeenCalledTimes(1);
  expect(await store.offset()).toBe(3);
 }finally{store.close();}
});
it('does not treat a review button on a customer request as a completed creation',async()=>{
 const store=new TelegramStore(':memory:','customer-review');await store.init();
 const engine=stubEngine('ready','Summary','customer');
 const createCustomer=vi.fn(async()=>'Created');
 const controller=new TelegramController(config(),'bot',store,engine,async()=>({message_id:100}),createCustomer);
 try{
  await controller.handle(message(1,'@bot crea il cliente Example Studio'));
  await controller.handle(press(2,'review:u1:1',100));
  expect((await store.order('u1'))?.status).toBe('ready');expect(createCustomer).not.toHaveBeenCalled();
 }finally{store.close();}
});
