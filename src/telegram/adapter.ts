import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';

const updateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: z.object({
    message_id: z.number().int(),
    chat: z.object({ id: z.number().int().safe(), type: z.enum(['group', 'supergroup', 'private', 'channel']) }),
    from: z.object({ id: z.number().int().safe(), is_bot: z.boolean() }).optional(),
    sender_chat: z.unknown().optional(),
    text: z.string().optional(),
    reply_to_message: z.object({ message_id: z.number().int() }).optional(),
  }).optional(),
});
export type TextEvent = { updateId: number; groupId: string; senderId: string; messageId: number; replyTo?: number; text: string };

/** Transport normalization only. No model access, credentials, or business decisions. */
export function normalizeTextUpdate(input: unknown, config: AppConfig): TextEvent | null {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return null;
  const { update_id, message } = parsed.data;
  if (!message || !message.from || message.from.is_bot || message.sender_chat || !message.text) return null;
  if (!['group', 'supergroup'].includes(message.chat.type) || String(message.chat.id) !== config.telegram.groupId) return null;
  return {
    updateId: update_id, groupId: String(message.chat.id), senderId: String(message.from.id),
    messageId: message.message_id, replyTo: message.reply_to_message?.message_id, text: message.text,
  };
}

export function startsOrder(text: string) {
  return /^(?:(?:per favore|please)\s+)?(?:crea|creare|prepara|vorrei creare|vorrei fare|create|prepare|make)\s+(?:(?:un|un nuovo|a|a new|an)\s+)?(?:ordine|order)\b/i.test(text.trim());
}

/** Commands addressed to another bot are not commands for this one. */
export function parseCommand(text: string, botUsername: string) {
  const token = text.split(/\s/, 1)[0]!;
  const at = token.indexOf('@');
  const name = token.slice(1, at < 0 ? undefined : at);
  if (!token.startsWith('/') || !name || (at >= 0 && token.slice(at + 1) !== botUsername)) return undefined;
  return { name, text: text.slice(token.length).trim() };
}

export type OrderLink = { orderId: string; revision: number };
/** `open` is the sender's newest empty request; it receives their next plain message. */
export function routeTextEvent(event: TextEvent, config: AppConfig, botUsername: string, links: ReadonlyMap<number, OrderLink>, open?: OrderLink) {
  const command = parseCommand(event.text, botUsername);
  if (command && [config.telegram.command, 'order', 'ordine'].includes(command.name)) return { kind: 'new' as const, text: command.text };
  if (command && ['customer', 'cliente'].includes(command.name)) return { kind: 'new' as const, customer: true, text: command.text };
  const linked = event.replyTo === undefined ? undefined : links.get(event.replyTo);
  // Without a reply, the controller cancels the sender's latest request.
  if (command && ['annulla', 'cancel'].includes(command.name) && !command.text) return { kind: 'cancel' as const, orderId: linked?.orderId };
  if (linked) return { kind: 'reply' as const, ...linked, text: event.text };
  if (open && event.replyTo === undefined && !event.text.trim().startsWith('/')) return { kind: 'reply' as const, ...open, text: event.text };
  if (config.telegram.respondToAllMessages && startsOrder(event.text)) return { kind: 'new' as const, text: event.text.trim() };
  const mention = `@${botUsername}`;
  if (event.text.toLowerCase().split(/\s+/).includes(mention.toLowerCase())) return { kind: 'new' as const, catalogue: true, text: event.text.replace(new RegExp(`@${botUsername}\\b`, 'ig'), '').trim() };
  if (config.telegram.respondToAllMessages && !event.text.trim().startsWith('/')) return { kind: 'new' as const, catalogue: true, text: event.text.trim() };
  return { kind: 'unrouted' as const };
}

/** Callback payload is a revision-bound capability, checked against our stored message link. */
export function normalizeCallback(input: unknown, config: AppConfig) {
  const parsed = z.object({ update_id: z.number().int(), callback_query: z.object({
    id: z.string(), from: z.object({id:z.number().int().safe(), is_bot:z.boolean()}), data:z.string(),
    message:z.object({message_id:z.number().int(),chat:z.object({id:z.number().int().safe(),type:z.string()})})
  }) }).safeParse(input);
  if (!parsed.success) return undefined;
  const q = parsed.data.callback_query;
  if (q.from.is_bot || String(q.message.chat.id) !== config.telegram.groupId || !['group','supergroup'].includes(q.message.chat.type)) return undefined;
  const match = /^(save|customer|cancel):([a-zA-Z0-9_-]+):(\d+)$/.exec(q.data);
  if (!match) return undefined;
  return {id:q.id, orderId:match[2]!,revision:Number(match[3]), action:match[1]!, messageId:q.message.message_id,
    update:{update_id:parsed.data.update_id,message:{message_id:q.message.message_id,chat:q.message.chat,from:q.from,
      reply_to_message:{message_id:q.message.message_id},text:match[1]==='save'?'/confermaordine':match[1]==='customer'?'/confermacliente':'/annulla'}}};
}
