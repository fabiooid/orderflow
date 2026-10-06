export type Keyboard = { inline_keyboard: { text: string; callback_data: string }[][] };
/** Minimal Bot API transport. Tokens and upstream error bodies never reach logs. */
export class TelegramApi {
  constructor(private readonly token: string, private readonly request: typeof fetch = fetch) {
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');
  }
  async call<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
    try {
      const response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(40000),
      });
      const body = await response.json() as { ok: boolean; result: T };
      if (!response.ok || !body.ok) throw new Error();
      return body.result;
    } catch { throw new Error(`Telegram ${method} failed; check connectivity, permissions, and rate limits`); }
  }
  getMe() { return this.call<{ id: number; username: string; is_bot: boolean; can_read_all_group_messages?: boolean }>('getMe'); }
  /** File bytes for a received file. The file URL contains the token, so it never leaves this method. */
  async download(fileId: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
    if (!file.file_path || (file.file_size ?? 0) > maxBytes) throw new Error('Telegram file is unavailable or too large');
    try {
      const response = await this.request(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error();
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new Error();
      return bytes;
    } catch { throw new Error('Telegram file download failed'); }
  }
  getWebhookInfo() { return this.call<{ url: string }>('getWebhookInfo'); }
  getChat(chatId: string) { return this.call<{ id: number; type: string; permissions?: { can_send_messages?: boolean; can_send_documents?: boolean } }>('getChat', { chat_id: chatId }); }
  getChatMember(chatId: string, userId: number) { return this.call<{ status: string; can_send_messages?: boolean; can_send_documents?: boolean }>('getChatMember', { chat_id: chatId, user_id: userId }); }
  updates(offset: number) { return this.call<{ update_id: number }[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }); }
  sendText(groupId: string, text: string, replyTo: number, keyboard?: Keyboard) {
    return this.call<{ message_id: number }>('sendMessage', {
      chat_id: groupId, text, reply_parameters: { message_id: replyTo }, reply_markup: keyboard,
    });
  }
  /** Shows "typing…" in the group for about five seconds. */
  typing(groupId: string) { return this.call('sendChatAction', { chat_id: groupId, action: 'typing' }); }
  answerCallback(id: string) { return this.call('answerCallbackQuery', { callback_query_id: id }); }
  clearButtons(groupId: string, messageId: number) { return this.call('editMessageReplyMarkup', {chat_id: groupId, message_id: messageId, reply_markup: {inline_keyboard: []}}); }
  /** Accept only a trusted URL returned by the connector, never a user/model URL. */
  sendOrderPdf(groupId: string, url: string, caption: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Invalid document URL');
    return this.call<{ message_id: number }>('sendDocument', { chat_id: groupId, document: url, caption });
  }
}
