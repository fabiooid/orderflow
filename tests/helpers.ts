import { vi } from 'vitest';
import example from '../config/example.json';
import { configSchema } from '../src/config/schema.js';
import { DemoConnector } from '../src/connector/demo.js';
import { draftSchema } from '../src/domain/types.js';
import { prepareOrder } from '../src/domain/prepare.js';
import type { TurnInput, TurnOutput } from '../src/telegram/controller.js';
import type { Conversation } from '../src/telegram/store.js';
export const config = () => configSchema.parse(structuredClone(example));
export const draft = () => draftSchema.parse({
  clientQuery: 'Example Studio', lines: [{ query: 'Amber hand wash 250 ml', quantity: 2 }], shippingPrice: 8, discountPercent: 10,
});
export async function prepared() {
  const result = await prepareOrder(draft(), config(), new DemoConnector(), '2026-01-15');
  if (!result.ready) throw new Error('Fixture did not prepare');
  return result.order;
}

/** Telegram updates as the group sends them: a message (optionally a reply) or a button press under a bot message. */
export function message(id: number, text: string, reply?: number, sender = 5) {
  return { update_id: id, message: { message_id: id, chat: { id: -1000000000001, type: 'supergroup' }, from: { id: sender, is_bot: false }, text, reply_to_message: reply ? { message_id: reply } : undefined } };
}
export function press(id: number, data: string, messageId: number, sender = 5) {
  return { update_id: id, callback_query: { id: `q${id}`, from: { id: sender, is_bot: false }, data, message: { message_id: messageId, chat: { id: -1000000000001, type: 'supergroup' } } } };
}

/**
 * A stand-in for the agent: each turn opens a new request or moves the open one to `status`, replying `text`. When
 * another request blocks a new one, it reports that the way the draft tools do.
 */
export function stubEngine(status: Conversation['status'] = 'ready', text = 'Summary', kind: 'order' | 'customer' = 'order') {
  return {
    turn: vi.fn(async (input: TurnInput): Promise<TurnOutput> => {
      if (!input.request && input.locked) return { text: 'Another request is open.', reply: '', locale: 'it', blocked: true };
      const previous = input.request ?? input.fresh(kind);
      return { text, reply: '', locale: 'it', order: { ...previous, revision: previous.revision + 1, status } };
    }),
    revise: vi.fn(async (previous: Conversation) => ({ order: { ...previous, revision: previous.revision + 1, status }, text })),
  };
}
