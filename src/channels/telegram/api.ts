export type Keyboard = { inline_keyboard: { text: string; callback_data: string }[][] };

class TelegramApiError extends Error {
  constructor(method: string, readonly failure: string) {
    super(`Telegram ${method} failed (${failure}); check connectivity, permissions, and rate limits`);
  }
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}

function systemCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') return;
  if (/^[A-Z][A-Z0-9_]{1,32}$/.test(error.code)) return error.code;
}

/** Host-safe class: timeout, rate_limit, auth, conflict, http_NNN, or a short system code. Never a message, URL or token. */
export function telegramErrorClass(error: unknown, status?: number): string {
  if (error instanceof TelegramApiError) return error.failure;
  const code = httpStatus(status);
  if (code === 401 || code === 403) return 'auth';
  if (code === 409) return 'conflict';
  if (code === 429) return 'rate_limit';
  if (code) return `http_${code}`;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout';
  const sys = systemCode(error);
  if (sys && (sys.endsWith('TIMEOUT') || sys.endsWith('TIMEDOUT') || sys === 'ECONNABORTED')) return 'timeout';
  if (sys) return sys;
  if (error instanceof Error && error.cause !== undefined && error.cause !== error) return telegramErrorClass(error.cause, status);
  return 'unavailable';
}

/** getUpdates retry line for a host log. Class only; tokens, URLs and message bodies stay out. */
export function pollingRetryWarning(error: unknown): string {
  return `Telegram polling unavailable (${telegramErrorClass(error)}); retrying the read in 5 seconds. No writes retried.`;
}

/** Minimal Bot API transport. Tokens and upstream error bodies never reach logs. */
export class TelegramApi {
  constructor(private readonly token: string, private readonly request: typeof fetch = fetch) {
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');
  }
  async call<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
    let status: number | undefined;
    try {
      const response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(40000),
      });
      status = response.status;
      const body = await response.json() as { ok?: boolean; result?: T; error_code?: unknown };
      if (response.ok && body.ok) return body.result as T;
      status = httpStatus(body.error_code) ?? response.status;
    } catch (error) {
      throw new TelegramApiError(method, telegramErrorClass(error, status));
    }
    throw new TelegramApiError(method, telegramErrorClass(undefined, status));
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
