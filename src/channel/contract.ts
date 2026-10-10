import type { AppConfig } from '../config/schema.js';

/** Transport cap for one inbound file. Telegram's Bot API stops at 20 MB; other channels can document their own cap. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export type Attachment = { kind: 'voice' | 'image' | 'pdf'; fileId: string; mimeType: string; size?: number };

/** A message the conversation core can route. Ids are the channel's own ids. */
export type MessageEvent = {
  updateId: number; groupId: string; senderId: string; messageId: number; replyTo?: number;
  text: string;
  attachments?: Attachment[];
  forwardedFrom?: string;
  album?: string;
};

export type OrderLink = { orderId: string; revision: number };

export type Keyboard = { inline_keyboard: { text: string; callback_data: string }[][] };

export type ParsedCallback = {
  id: string;
  messageId: number;
  target?: OrderLink;
  event: MessageEvent;
  action:
    | { kind: 'pending'; message: number; accept: boolean }
    | { kind: 'pick'; target: OrderLink; choice: { field: string; id: number } }
    | { kind: 'confirmOrder' | 'confirmCustomer' | 'review' | 'cancel' | 'cancelAll'; target: OrderLink };
};

/**
 * One messaging platform. Inbound parsing and outbound delivery live here.
 * Order drafts, totals and confirmation do not.
 */
export interface ChannelAdapter {
  readonly provider: string;
  /** Shown on a new shared memory thread. */
  readonly threadTitle: string;
  parseMessage(update: unknown, config: AppConfig): MessageEvent | null;
  parseCallback(update: unknown, config: AppConfig): ParsedCallback | undefined;
  sendText(conversationId: string, text: string, replyTo: number, keyboard?: Keyboard): Promise<{ message_id: number }>;
}
