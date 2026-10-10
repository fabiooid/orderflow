import { describe, expect, it, vi } from 'vitest';
import { TelegramApi } from '../src/channels/telegram/api.js';
import { TelegramChannel } from '../src/channels/telegram/adapter.js';
import type { ChannelAdapter } from '../src/channel/contract.js';
import { config, message, press } from './helpers.js';

/**
 * Every channel adapter must pass this suite. It checks parsing and one outbound text send.
 * Add the new adapter next to TelegramChannel.
 */
export function runChannelContract(name: string, create: () => { adapter: ChannelAdapter; sent: () => unknown[] }) {
  describe(`channel contract: ${name}`, () => {
    it('reads a message from the configured conversation and ignores any other chat', () => {
      const { adapter } = create();
      const event = adapter.parseMessage(message(4, 'two pebble'), config());
      expect(event).toMatchObject({ updateId: 4, senderId: '5', text: 'two pebble', groupId: config().channel.groupId });
      const other = message(5, 'hello');
      (other.message.chat as { id: number }).id = -1;
      expect(adapter.parseMessage(other, config())).toBeNull();
    });

    it('reads a confirmation button as a revision-bound action', () => {
      const { adapter } = create();
      const parsed = adapter.parseCallback(press(9, 'save:u1:2', 100), config());
      expect(parsed).toMatchObject({ action: { kind: 'confirmOrder', target: { orderId: 'u1', revision: 2 } } });
      expect(adapter.parseCallback(press(9, 'delete:u1:2', 100), config())).toBeUndefined();
    });

    it('sends text back to that conversation', async () => {
      const { adapter, sent } = create();
      await adapter.sendText(config().channel.groupId, 'Ciao', 3);
      expect(sent()).toContainEqual({ conversationId: config().channel.groupId, text: 'Ciao' });
    });
  });
}

runChannelContract('telegram', () => {
  const sent: { conversationId: string; text: string }[] = [];
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })));
  const adapter = new TelegramChannel(new TelegramApi('test-token', fetch));
  const send = adapter.sendText.bind(adapter);
  adapter.sendText = async (conversationId, text, replyTo, keyboard) => {
    sent.push({ conversationId, text });
    return send(conversationId, text, replyTo, keyboard);
  };
  return { adapter, sent: () => sent };
});
