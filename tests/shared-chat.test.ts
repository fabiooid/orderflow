import {expect,it,vi} from 'vitest';
import {TelegramController, type ConversationEngine} from '../src/telegram/controller.js';
import {TelegramStore} from '../src/telegram/store.js';
import {config,prepared} from './helpers.js';
import type {Keyboard} from '../src/telegram/api.js';

const msg=(id:number,text:string,sender=5)=>({update_id:id,message:{message_id:id,chat:{id:-1000000000001,type:'supergroup'},from:{id:sender,is_bot:false},text}});
const tap=(id:number,messageId:number,data:string,chat=-1000000000001)=>({update_id:id,callback_query:{id:`cb${id}`,from:{id:7,is_bot:false},data,message:{message_id:messageId,chat:{id:chat,type:'supergroup'}}}});
it('shares context with colleagues, preserves drafts during questions and saves only a current button once',async()=>{
 const c=config(); c.orderSavingEnabled=true;c.telegram.respondToAllMessages=true;
 const store=new TelegramStore(':memory:','shared');await store.init();
 const process=vi.fn(async(text:string,p:any)=>({conversation:{...p,revision:p.revision+1,status:'ready' as const,prepared:await prepared(),totals:{net:1,vat:0,gross:1}},text:'Summary'}));
 const route=vi.fn(async(text:string)=>text==='question'?{action:'answer' as const,text:'Catalogue answer'}:text==='start'?{action:'order' as const,text:'two bottles'}:{action:'continue' as const,text});
 const engine:ConversationEngine=Object.assign(process,{route,record:vi.fn(async()=>{})});
 let mid=100;
 const send=vi.fn(async(_text:string,_reply:number,_keyboard?:Keyboard)=>({message_id:mid++}));
 const save=vi.fn(async()=>({id:321,number:'42'}));const pdf=vi.fn(async()=>({message_id:500}));
 const controller=new TelegramController(c,'bot',store,engine,send,undefined,save,pdf);
 try {
  await controller.handle(msg(1,'start'));
  expect(send.mock.calls[0]?.[2]?.inline_keyboard[0]?.[0]?.callback_data).toBe('save:u1:1');
  await controller.handle(msg(2,'question',7));
  expect((await store.order('u1'))?.revision).toBe(1);expect(process).toHaveBeenCalledTimes(1);
  await controller.handle(msg(3,'make it three',7));
  expect(process.mock.calls[1]?.[1].orderId).toBe('u1');
  expect(route.mock.calls[2]?.[0]).toBe('make it three');
  await controller.handle(tap(4,100,'save:u1:1'));expect(save).not.toHaveBeenCalled();
  await controller.handle(tap(5,102,'save:u1:2',99));expect(save).not.toHaveBeenCalled();
  await controller.handle(tap(6,102,'save:u1:2'));expect(save).toHaveBeenCalledTimes(1);expect(pdf).toHaveBeenCalledTimes(1);
  await controller.handle(tap(6,102,'save:u1:2'));expect(save).toHaveBeenCalledTimes(1);
  expect(await store.activeRequest()).toBeUndefined();
 }finally{store.close();}
});
it('accepts natural cancellation without writing a customer or order',async()=>{
 const c=config();c.telegram.respondToAllMessages=true;
 const store=new TelegramStore(':memory:','cancel');await store.init();
 const process=vi.fn(async(_text:string,p:any)=>({conversation:{...p,status:'suspended' as const,revision:1},text:'Which size?'}));
 const engine=Object.assign(process,{route:vi.fn(async()=>({action:'cancel' as const,text:''}))});
 const controller=new TelegramController(c,'bot',store,engine,async()=>({message_id:100}));
 try{await controller.handle(msg(1,'/ordine two'));await controller.handle(msg(2,'annulla questo ordine',7));expect((await store.order('u1'))?.status).toBe('cancelled');expect(process).toHaveBeenCalledTimes(1);}finally{store.close();}
});
it('resumes a saved callback delivery after restart without repeating the write',async()=>{
 const c=config();c.orderSavingEnabled=true;
 const store=new TelegramStore(':memory:','replay');await store.init();
 const engine:ConversationEngine=async(_text,p)=>({conversation:{...p,revision:1,status:'ready',prepared:await prepared(),totals:{net:1,vat:0,gross:1}},text:'Summary'});
 let mid=100;const send=async()=>({message_id:mid++});
 const save=vi.fn(async()=>({id:321,number:'42'}));
 const pdf=vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({message_id:500});
 const controller=new TelegramController(c,'bot',store,engine,send,undefined,save,pdf);
 try{
  await controller.handle(msg(1,'/ordine two'));
  const click=tap(2,100,'save:u1:1');
  await expect(controller.handle(click)).rejects.toThrow('timeout');
  await store.retrySend(2); // Operator checked that the PDF did not arrive.
  await controller.handle(click);
  expect(save).toHaveBeenCalledTimes(1);expect(pdf).toHaveBeenCalledTimes(2);expect(await store.offset()).toBe(3);
 }finally{store.close();}
});
