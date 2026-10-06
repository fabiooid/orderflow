import { translate, type AppConfig } from '../config/schema.js';
import { parseCommand, startsOrder, type OrderLink, type TextEvent } from './adapter.js';
import type { Conversation } from './store.js';

export type Intent = { action: 'continue' | 'order' | 'customer' | 'cancel' | 'answer'; text: string };
export type IntentRouter = (text: string, senderId: string, active?: Conversation) => Promise<Intent>;

/** Everything the controller can do in response to a message or button. */
export type Action =
  | { kind: 'start'; customer: boolean; text: string }
  | { kind: 'edit'; target: OrderLink; text: string }
  | { kind: 'confirmOrder' | 'confirmCustomer' | 'review' | 'reopen'; target: OrderLink }
  | { kind: 'cancel'; target?: OrderLink }
  | { kind: 'answer'; text: string }
  | { kind: 'ignore' };

const commands: Record<string, 'start' | 'customer' | 'cancel' | 'confirmOrder' | 'confirmCustomer' | 'review' | 'reopen'> = {
  order: 'start', ordine: 'start', customer: 'customer', cliente: 'customer', cancel: 'cancel', annulla: 'cancel',
  confirmorder: 'confirmOrder', confermaordine: 'confirmOrder', confirmcustomer: 'confirmCustomer', confermacliente: 'confirmCustomer',
  review: 'review', reopen: 'reopen',
};

/** Commands are deterministic; commands for other bots and unknown commands are ignored. */
export function commandAction(text: string, config: AppConfig, botUsername: string, link?: OrderLink): Action {
  const command = parseCommand(text.trim(), botUsername);
  const kind = command && (command.name === config.telegram.command ? 'start' : commands[command.name]);
  if (!command || !kind) return { kind: 'ignore' };
  if (kind === 'start' || kind === 'customer') return { kind: 'start', customer: kind === 'customer', text: command.text };
  // A command with trailing text is not a bare command: treat a reply to a summary as an edit of it.
  if (command.text) return link ? { kind: 'edit', target: link, text } : { kind: 'ignore' };
  if (kind === 'cancel') return { kind: 'cancel', target: link };
  // Confirmations, review and reopen must reply to the summary they act on.
  return link ? { kind, target: link } : { kind: 'ignore' };
}

export type RoutingContext = {
  config: AppConfig; botUsername: string;
  /** The stored link for the replied-to bot message, and its conversation when one exists. */
  link?: OrderLink; linked?: Conversation;
  active?: Conversation;
  /** Model intent routing; absent for scripted engines, which use the rules below. */
  model?: IntentRouter;
};

export async function routeMessage(event: TextEvent, ctx: RoutingContext): Promise<Action> {
  const { config, link, linked, active } = ctx;
  if (event.text.trim().startsWith('/')) return commandAction(event.text, config, ctx.botUsername, link);
  // A reply to an older summary must never be reinterpreted against a newer draft.
  if (link && linked && linked.revision !== link.revision) return { kind: 'edit', target: link, text: event.text };
  const mention = new RegExp(`(^|\\s)@${ctx.botUsername}\\b`, 'i');
  const addressed = Boolean(link) || mention.test(event.text) || config.telegram.respondToAllMessages || (active !== undefined && event.replyTo === undefined);
  if (!addressed) return { kind: 'ignore' };
  const selected = link ? linked : active;
  const target = selected && { orderId: selected.orderId, revision: selected.revision };
  if (ctx.model) {
    const intent = await ctx.model(event.text, event.senderId, selected).catch((): Intent => ({ action: 'answer', text: translate(config,
      'Non riesco a elaborare il messaggio. Riprova; la richiesta aperta non è stata modificata.',
      'Unable to process this message. Please retry; the open request is unchanged.') }));
    switch (intent.action) {
      case 'answer': return { kind: 'answer', text: intent.text };
      case 'cancel': return { kind: 'cancel', target };
      case 'order': case 'customer': return { kind: 'start', customer: intent.action === 'customer', text: intent.text };
      case 'continue': return target
        ? { kind: 'edit', target, text: intent.text }
        : { kind: 'answer', text: translate(config, 'Quale ordine o cliente vuoi preparare?', 'Which order or customer would you like to prepare?') };
    }
  }
  if (target) return { kind: 'edit', target, text: event.text };
  const text = event.text.replace(mention, ' ').trim();
  return startsOrder(text) ? { kind: 'start', customer: false, text } : { kind: 'ignore' };
}
