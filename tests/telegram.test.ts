import { expect, it } from 'vitest';
import { normalizeTextUpdate, routeTextEvent } from '../src/telegram/adapter.js';
import { config } from './helpers.js';
const update = () => ({ update_id: 1, message: { message_id: 2, chat: { id: -1000000000001, type: 'supergroup' }, from: { id: 5, is_bot: false }, text: '/order two notebooks' } });
it('accepts any human member of the configured group, rejects other chats and bots', () => {
  expect(normalizeTextUpdate(update(), config())?.senderId).toBe('5');
  const other = update(); other.message.chat.id = -999;
  expect(normalizeTextUpdate(other, config())).toBeNull();
  const bot = update(); bot.message.from.is_bot = true;
  expect(normalizeTextUpdate(bot, config())).toBeNull();
});
it('routes replies by message reference, not by whoever last spoke', () => {
  const event = normalizeTextUpdate(update(), config())!;
  expect(routeTextEvent(event, config(), 'demo_bot', new Map()).kind).toBe('new');
  const links = new Map([[10, { orderId: 'first', revision: 1 }], [20, { orderId: 'second', revision: 2 }]]);
  expect(routeTextEvent({ ...event, text: 'make that 12', replyTo: 10 }, config(), 'demo_bot', links)).toMatchObject({ kind: 'reply', orderId: 'first' });
  expect(routeTextEvent({ ...event, text: 'make that 12' }, config(), 'demo_bot', links).kind).toBe('unrouted');
  expect(routeTextEvent({ ...event, text: '/order@other_bot two' }, config(), 'demo_bot', links).kind).toBe('unrouted');
});
it('routes natural questions addressed to this bot and keeps follow-ups in the linked conversation', () => {
 const event = normalizeTextUpdate(update(), config())!;
 expect(routeTextEvent({ ...event, text: '@demo_bot quali varianti di Sapone Zenzero abbiamo?' }, config(), 'demo_bot', new Map())).toMatchObject({kind:'new',catalogue:true,text:'quali varianti di Sapone Zenzero abbiamo?'});
 expect(routeTextEvent({ ...event, text: '@other_bot domanda' }, config(), 'demo_bot', new Map()).kind).toBe('unrouted');
 expect(routeTextEvent({ ...event, text: 'e i tester?', replyTo: 10 }, config(), 'demo_bot', new Map([[10,{orderId:'catalogue',revision:1}]]))).toMatchObject({kind:'reply',orderId:'catalogue'});
});
it('allows ordinary messages only when explicitly configured and leaves unknown commands alone', () => {
 const c = config(); c.telegram.respondToAllMessages = true;
 const event = normalizeTextUpdate(update(), c)!;
 expect(routeTextEvent({...event,text:'Quali formati abbiamo?'},c,'demo_bot',new Map())).toMatchObject({kind:'new',catalogue:true});
 expect(routeTextEvent({...event,text:'/confirmcustomer'},c,'demo_bot',new Map()).kind).toBe('unrouted');
 c.telegram.respondToAllMessages = false;
 expect(routeTextEvent({...event,text:'Quali formati abbiamo?'},c,'demo_bot',new Map()).kind).toBe('unrouted');
});
it('accepts Italian customer and order commands with optional bot suffix', () => {
 const event = normalizeTextUpdate(update(), config())!;
 for (const text of ['/cliente Mario', '/cliente@demo_bot Mario']) expect(routeTextEvent({...event,text},config(),'demo_bot',new Map())).toMatchObject({kind:'new',customer:true,text:'Mario'});
 for (const text of ['/ordine due saponi', '/ordine@demo_bot due saponi']) expect(routeTextEvent({...event,text},config(),'demo_bot',new Map())).toMatchObject({kind:'new',text:'due saponi'});
 expect(routeTextEvent({...event,text:'/cliente@other_bot Mario'},config(),'demo_bot',new Map()).kind).toBe('unrouted');
});
it('routes cancel commands to the replied-to request or the sender’s latest one', () => {
 const event = normalizeTextUpdate(update(), config())!;
 const links = new Map([[10, { orderId: 'first', revision: 1 }]]);
 expect(routeTextEvent({...event,text:'/annulla',replyTo:10},config(),'demo_bot',links)).toMatchObject({kind:'cancel',orderId:'first'});
 expect(routeTextEvent({...event,text:'/cancel@demo_bot'},config(),'demo_bot',links)).toMatchObject({kind:'cancel',orderId:undefined});
 expect(routeTextEvent({...event,text:'/annulla@other_bot'},config(),'demo_bot',links).kind).toBe('unrouted');
});
it('recognizes an explicit natural-language order request without treating catalogue questions as orders', () => {
 const c=config();c.telegram.respondToAllMessages=true;const event=normalizeTextUpdate(update(),c)!;
 const route=routeTextEvent({...event,text:'crea ordine per Cliente Test: 5 Sapone Mani Lavanda 250ml'},c,'demo_bot',new Map());
 expect(route).toMatchObject({kind:'new'});expect('catalogue' in route).toBe(false);
 expect(routeTextEvent({...event,text:'Quali saponi abbiamo?'},c,'demo_bot',new Map())).toMatchObject({catalogue:true});
});
