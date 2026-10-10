import { TelegramApi } from '../src/channels/telegram/api.js';
try {
  const api = new TelegramApi(process.env.TELEGRAM_BOT_TOKEN ?? '');
  const me = await api.getMe();
  if ((await api.getWebhookInfo()).url) throw new Error();
  const updates = await api.call<{ message?: { chat: { id: number; type: string; title?: string } } }[]>('getUpdates', { timeout: 0 });
  const chats = new Map<number, string>();
  for (const u of updates) if (u.message && ['group', 'supergroup'].includes(u.message.chat.type)) chats.set(u.message.chat.id, u.message.chat.title ?? 'Group');
  console.log(`Bot: @${me.username}. Stop any other poller before discovery.`);
  for (const [id, name] of chats) console.log(`${name}: ${id}`);
  if (!chats.size) console.log(`Add the bot to your group, mention @${me.username} in it, then run this command again.`);
  console.log('No messages sent or updates acknowledged. Copy only your intended group ID into local configuration.');
} catch { console.error('Discovery failed. Check the bot token/network and stop any existing poller or webhook integration.'); process.exitCode = 1; }
