import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';

/** Bot API downloads stop at 20 MB. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const file = z.object({ file_id: z.string().min(1), file_size: z.number().int().optional(), mime_type: z.string().optional() });
const person = z.object({ first_name: z.string(), last_name: z.string().optional() });
const updateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: z.object({
    message_id: z.number().int(),
    chat: z.object({ id: z.number().int().safe(), type: z.enum(['group', 'supergroup', 'private', 'channel']) }),
    from: z.object({ id: z.number().int().safe(), is_bot: z.boolean() }).optional(),
    sender_chat: z.unknown().optional(),
    text: z.string().optional(),
    caption: z.string().optional(),
    voice: file.optional(),
    audio: file.optional(),
    photo: z.array(file).optional(),
    document: file.optional(),
    media_group_id: z.string().optional(),
    forward_origin: z.object({
      type: z.string(), sender_user: person.optional(), sender_user_name: z.string().optional(), chat: z.object({ title: z.string().optional() }).optional(),
    }).optional(),
    reply_to_message: z.object({ message_id: z.number().int() }).optional(),
  }).optional(),
});

/** A Telegram file reference; the bytes are downloaded only when the message is processed. */
export type Attachment = { kind: 'voice' | 'image' | 'pdf'; fileId: string; mimeType: string; size?: number };
export type MessageEvent = {
  updateId: number; groupId: string; senderId: string; messageId: number; replyTo?: number;
  /** Message text or media caption. */
  text: string;
  attachments?: Attachment[];
  /** Display name of the original sender of a forwarded message. */
  forwardedFrom?: string;
  album?: string;
};

function attachments(message: NonNullable<z.infer<typeof updateSchema>['message']>): Attachment[] {
  const found: Attachment[] = [];
  const audio = message.voice ?? message.audio;
  if (audio) found.push({ kind: 'voice', fileId: audio.file_id, mimeType: audio.mime_type ?? 'audio/ogg', size: audio.file_size });
  // Telegram sends each photo in several sizes; the last is the largest.
  const photo = message.photo?.at(-1);
  if (photo) found.push({ kind: 'image', fileId: photo.file_id, mimeType: 'image/jpeg', size: photo.file_size });
  const doc = message.document;
  if (doc?.mime_type === 'application/pdf') found.push({ kind: 'pdf', fileId: doc.file_id, mimeType: doc.mime_type, size: doc.file_size });
  else if (doc?.mime_type && /^image\/(jpeg|png|webp|gif)$/.test(doc.mime_type)) found.push({ kind: 'image', fileId: doc.file_id, mimeType: doc.mime_type, size: doc.file_size });
  return found;
}

function forwardName(origin: NonNullable<z.infer<typeof updateSchema>['message']>['forward_origin']) {
  if (!origin) return undefined;
  const user = origin.sender_user && [origin.sender_user.first_name, origin.sender_user.last_name].filter(Boolean).join(' ');
  return user || origin.sender_user_name || origin.chat?.title || '?';
}

/** Transport normalization only. No model access, credentials, or business decisions. */
export function normalizeMessage(input: unknown, config: AppConfig): MessageEvent | null {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return null;
  const { update_id, message } = parsed.data;
  if (!message || !message.from || message.from.is_bot || message.sender_chat) return null;
  if (!['group', 'supergroup'].includes(message.chat.type) || String(message.chat.id) !== config.telegram.groupId) return null;
  const files = attachments(message);
  const text = message.text ?? message.caption ?? '';
  if (!text && !files.length) return null;
  return {
    updateId: update_id, groupId: String(message.chat.id), senderId: String(message.from.id),
    messageId: message.message_id, replyTo: message.reply_to_message?.message_id, text,
    ...(files.length ? { attachments: files } : {}),
    ...(message.forward_origin ? { forwardedFrom: forwardName(message.forward_origin) } : {}),
    ...(message.media_group_id ? { album: message.media_group_id } : {}),
  };
}

export const albumOf = (update: unknown) => (update as { message?: { media_group_id?: unknown } } | undefined)?.message?.media_group_id;

/** Consecutive updates of one Telegram album (several photos sent together) form one group; others stand alone. */
export function groupAlbums<T>(updates: T[]): T[][] {
  const groups: T[][] = [];
  for (const update of updates) {
    const last = groups.at(-1);
    if (albumOf(update) !== undefined && last && albumOf(last[0]) === albumOf(update)) last.push(update);
    else groups.push([update]);
  }
  return groups;
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

const callbackActions = { save: 'confirmOrder', customer: 'confirmCustomer', cancel: 'cancel' } as const;
/** Command equivalents, recorded as the button press's incoming text. */
const callbackLabels = { save: '/confermaordine', customer: '/confermacliente', cancel: '/annulla' } as const;
export const callbackData = (action: keyof typeof callbackActions, link: OrderLink) => `${action}:${link.orderId}:${link.revision}`;

/** Callback payload is a revision-bound capability, checked against our stored message link. */
export function normalizeCallback(input: unknown, config: AppConfig) {
  const parsed = z.object({ update_id: z.number().int(), callback_query: z.object({
    id: z.string(), from: z.object({id:z.number().int().safe(), is_bot:z.boolean()}), data:z.string(),
    message:z.object({message_id:z.number().int(),chat:z.object({id:z.number().int().safe(),type:z.string()})})
  }) }).safeParse(input);
  if (!parsed.success) return undefined;
  const q = parsed.data.callback_query;
  if (q.from.is_bot || String(q.message.chat.id) !== config.telegram.groupId || !['group','supergroup'].includes(q.message.chat.type)) return undefined;
  const base = { updateId: parsed.data.update_id, groupId: config.telegram.groupId, senderId: String(q.from.id), messageId: q.message.message_id, replyTo: q.message.message_id };
  const media = /^media:(\d+):([yn])$/.exec(q.data);
  if (media) {
    const accept = media[2] === 'y';
    const event: MessageEvent = { ...base, text: accept ? '✅' : '✖️' };
    return { id: q.id, messageId: q.message.message_id, event, action: { kind: 'pending', message: Number(media[1]), accept } as const };
  }
  const match = /^(save|customer|cancel):([a-zA-Z0-9_-]+):(\d+)$/.exec(q.data);
  if (!match) return undefined;
  const button = match[1] as keyof typeof callbackActions;
  const target: OrderLink = { orderId: match[2]!, revision: Number(match[3]) };
  const event: MessageEvent = { ...base, text: callbackLabels[button] };
  return { id: q.id, messageId: q.message.message_id, target, event, action: { kind: callbackActions[button], target } as const };
}

/** Buttons under a prompt for media that did not say what to do with it. */
export const mediaCallbackData = (message: number, accept: boolean) => `media:${message}:${accept ? 'y' : 'n'}`;
