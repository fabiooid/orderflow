import type { AppConfig } from '../config/schema.js';
import type { MessageEvent, OrderLink } from './adapter.js';
import type { Conversation } from './store.js';

/** Everything the controller can do in response to a message or button. */
export type Action =
  /** An operator message for the agent; `target` is the request whose message it replies to. */
  | { kind: 'converse'; text: string; operatorText: string; target?: OrderLink }
  | { kind: 'confirmOrder' | 'confirmCustomer' | 'review'; target: OrderLink }
  /** A candidate picked with a button under a draft. */
  | { kind: 'pick'; target: OrderLink; choice: { field: string; id: number } }
  | { kind: 'cancel'; target?: OrderLink }
  /** Void every open request; a button binds it to the newest one it listed. */
  | { kind: 'cancelAll'; target?: OrderLink }
  | { kind: 'answer'; text: string }
  /** A reply to an older revision of a request, which must not be reinterpreted against the newer one. */
  | { kind: 'stale' }
  /** Ask what to do with media or a forward that did not say. */
  | { kind: 'prompt' }
  /** A button under that question; message is the original media message. */
  | { kind: 'pending'; message: number; accept: boolean }
  | { kind: 'ignore' };

export type RoutingContext = {
  config: AppConfig; botUsername: string;
  /** The stored link for the replied-to bot message, and its conversation when one exists. */
  link?: OrderLink; linked?: Conversation;
  active?: Conversation;
  /** The operator's own words when event.text also carries content read from attachments. */
  operatorText?: string;
};

/**
 * Media with no caption carries no intent, so ask before spending model calls on it. Two exceptions: a reply to a bot
 * message belongs to that request, and a voice note is spoken text, handled like a typed message wherever one would be.
 */
export function asksFirst(event: MessageEvent, ctx: Pick<RoutingContext, 'config' | 'link' | 'active'>) {
  const files = event.attachments ?? [];
  if (!files.length || event.text.trim() || ctx.link) return false;
  const spoken = files.every(f => f.kind === 'voice');
  return !(spoken && (ctx.config.telegram.respondToAllMessages || (ctx.active !== undefined && event.replyTo === undefined)));
}

/** Decides only whether a message is for the agent; what it means is the agent's job. */
export function routeMessage(event: MessageEvent, ctx: RoutingContext): Action {
  const { config, link, linked, active } = ctx;
  if (link && linked && linked.revision !== link.revision) return { kind: 'stale' };
  const mention = new RegExp(`(^|\\s)@${ctx.botUsername}\\b`, 'i');
  const addressed = Boolean(link) || mention.test(event.text) || config.telegram.respondToAllMessages || (active !== undefined && event.replyTo === undefined);
  // Forwarded customer messages and files are rarely chat between colleagues: ask rather than drop them.
  if (!addressed) return event.attachments?.length || event.forwardedFrom ? { kind: 'prompt' } : { kind: 'ignore' };
  const clean = (text: string) => text.replace(mention, ' ').trim();
  return { kind: 'converse', text: clean(event.text), operatorText: clean(ctx.operatorText ?? event.text), ...(link ? { target: link } : {}) };
}
