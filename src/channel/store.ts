import { createClient, type Client } from '@libsql/client';
import type { Issue, OrderDraft, PreparedOrder, Totals, SavedOrder } from '../domain/types.js';
import type { ConfirmedChoice, Decision } from '../matching/resolver.js';
import type { MessageEvent, OrderLink } from './contract.js';
import type { AppConfig } from '../config/schema.js';
import type { ConnectorMode } from '../config/load.js';
/** Requests stored before customer requests existed have no kind: they are orders. */
export const kindOf = (c: Pick<Conversation, 'kind'>) => c.kind ?? 'order';
/** A request's conversation so far, the evidence identity matching reads; bounded so long requests stay usable. */
export const appendSource = (source: string | undefined, text: string) => [source, text].filter(Boolean).join('\n').slice(-12000);
/** One order or customer request. `issues` are what the order or customer API last reported as still needed. */
export type Conversation = { confirmedChoices?: ConfirmedChoice[]; sourceText?: string; matchingDecisions?: Decision[]; locale?: AppConfig['locale']; orderId: string; startedBy?: string; startedAt?: string; kind?: 'customer'; revision: number; status: 'new' | 'suspended' | 'ready' | 'reviewed' | 'saving' | 'saved' | 'cancelled'; prepared?: PreparedOrder; totals?: Totals; savedOrder?: SavedOrder; draft: OrderDraft; issues?: Issue[]; policy: string };
// Local state locations. Scopes include the mode so fictional state stays separate from account data.
export const TELEGRAM_STATE_URL = 'file:.data/telegram.db';
export const telegramScopePrefix = (config: AppConfig, mode: ConnectorMode) => `${config.deploymentId}:${config.channel.groupId}:${mode}:`;
export const telegramMemoryUrl = (config: AppConfig, mode: ConnectorMode) => `file:.data/telegram-${config.deploymentId}-${mode}.db`;
export const pollerLockPath = (config: AppConfig) => `.data/telegram-${config.deploymentId}.lock`;
/** Stable application-owned prefix for journaled writes; changing it would orphan stored journal entries. */
export function journalKey(config: AppConfig, conversationId: string) {
  return `${config.deploymentId}:${config.companyId}:${config.channel.groupId}:${conversationId}`;
}
export type ReplyPlan ={ locale?: AppConfig['locale']; incomingText?: string; senderId?: string; receivedAt?: string; texts: string[];
  /** The agent's own words within `texts`; the rest was written by the application (drafts, summaries, confirmations). */
  agentText?: string; pdfOrderId?: number; order?: Conversation; replyTo: number;
  /** Other requests this reply voids, stored with it. */
  cancelled?: Conversation[];
  /** The open request when the update arrived, for traces. */
  activeOrderId?: string;
  /** Newest open request when the reply lists open requests; it binds the void-all button. */
  voidAll?: OrderLink & { count: number };
  /** Original media message whose question the last text asks; it carries the yes/no buttons. */
  prompt?: { message: number; active: boolean } };
/** Media waiting for an answer to "prepare an order from this?". `read` keeps text already extracted from it. */
export type Pending = { event: MessageEvent; target?: OrderLink | null; read?: { text: string; echo?: string } };
export type PlanEffects = { pending?: { message: number; value: Pending }; consume?: number; absorbed?: number[] };

/** Durable transport state; Mastra continues to own workflow and conversation memory. */
export class TelegramStore {
  readonly db: Client;
  constructor(url: string, readonly scope: string) { this.db = createClient({ url }); }
  async init() {
    await this.db.batch([
      'CREATE TABLE IF NOT EXISTS tg_updates (scope TEXT, id INTEGER, plan TEXT NOT NULL, next_part INTEGER NOT NULL DEFAULT 0, sending INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,id))',
      'CREATE TABLE IF NOT EXISTS tg_orders (scope TEXT, id TEXT, state TEXT NOT NULL, PRIMARY KEY(scope,id))',
      'CREATE TABLE IF NOT EXISTS tg_links (scope TEXT, message INTEGER, order_id TEXT, revision INTEGER, PRIMARY KEY(scope,message))',
      'CREATE TABLE IF NOT EXISTS tg_offsets (scope TEXT PRIMARY KEY, offset INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS tg_locale (scope TEXT PRIMARY KEY, locale TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS tg_pending (scope TEXT, message INTEGER, album TEXT, state TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,message))',
    ], 'write');
  }
  /** Unanswered media, by its original message or by the album it belongs to. */
  async pending(by: { message: number } | { album: string }): Promise<{ message: number; value: Pending } | undefined> {
    const [column, value] = 'message' in by ? ['message', by.message] : ['album', by.album];
    const row = (await this.db.execute({ sql: `SELECT message,state FROM tg_pending WHERE scope=? AND ${column}=? AND used=0`, args: [this.scope, value] })).rows[0];
    return row ? { message: Number(row.message), value: JSON.parse(String(row.state)) } : undefined;
  }
  async offset() { return Number((await this.db.execute({ sql: 'SELECT offset FROM tg_offsets WHERE scope=?', args: [this.scope] })).rows[0]?.offset ?? 0); }
  async locale(): Promise<AppConfig['locale'] | undefined> {
    const value = (await this.db.execute({ sql: 'SELECT locale FROM tg_locale WHERE scope=?', args: [this.scope] })).rows[0]?.locale;
    return value === 'it' || value === 'en' ? value : undefined;
  }
  async advance(offset: number) { await this.db.execute({ sql: 'INSERT INTO tg_offsets VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET offset=MAX(offset,excluded.offset)', args: [this.scope, offset] }); }
  // Earlier versions stored catalogue answers as conversations; they are never requests and are skipped here.
  async order(id: string): Promise<Conversation | undefined> {
    const row = (await this.db.execute({ sql: "SELECT state FROM tg_orders WHERE scope=? AND id=? AND json_extract(state,'$.kind') IS NOT 'catalogue'", args: [this.scope, id] })).rows[0];
    return row ? JSON.parse(String(row.state)) : undefined;
  }
  async activeRequest(): Promise<Conversation | undefined> {
    return (await this.openRequests(1))[0];
  }
  /** Unsaved and unverified requests, newest first. */
  async openRequests(limit = -1): Promise<Conversation[]> {
    const rows = (await this.db.execute({
      sql: `SELECT state FROM tg_orders WHERE scope=? AND json_extract(state,'$.kind') IS NOT 'catalogue'
        AND json_extract(state,'$.status') IN ('new','suspended','ready','saving') ORDER BY rowid DESC LIMIT ?`,
      args: [this.scope, limit],
    })).rows;
    return rows.map(row => JSON.parse(String(row.state)));
  }
  async link(message: number): Promise<OrderLink | undefined> {
    const row = (await this.db.execute({ sql: 'SELECT order_id,revision FROM tg_links WHERE scope=? AND message=?', args: [this.scope, message] })).rows[0];
    return row ? { orderId: String(row.order_id), revision: Number(row.revision) } : undefined;
  }
  async update(id: number) {
    const row = (await this.db.execute({ sql: 'SELECT * FROM tg_updates WHERE scope=? AND id=?', args: [this.scope, id] })).rows[0];
    return row ? { plan: JSON.parse(String(row.plan)) as ReplyPlan, next: Number(row.next_part), sending: Boolean(row.sending), done: Boolean(row.done) } : undefined;
  }
  /** Stores the reply and its side effects atomically, so a replayed update finds them all or none. */
  async plan(id: number, plan: ReplyPlan, effects: PlanEffects = {}) {
    const silent = !plan.texts.length && plan.pdfOrderId === undefined;
    const statements: Parameters<Client['batch']>[0] = [{ sql: 'INSERT INTO tg_updates(scope,id,plan,done) VALUES (?,?,?,?)', args: [this.scope, id, JSON.stringify(plan), silent ? 1 : 0] }];
    if (plan.locale) statements.push({ sql: 'INSERT INTO tg_locale VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET locale=excluded.locale', args: [this.scope, plan.locale] });
    // Album parts merged into this update are handled; they must not be answered again on replay.
    for (const part of effects.absorbed ?? []) statements.push({ sql: 'INSERT OR IGNORE INTO tg_updates(scope,id,plan,done) VALUES (?,?,?,1)', args: [this.scope, part, JSON.stringify({ texts: [], replyTo: plan.replyTo })] });
    if (effects.pending) {
      const { message, value } = effects.pending;
      statements.push({ sql: 'INSERT INTO tg_pending(scope,message,album,state) VALUES (?,?,?,?) ON CONFLICT(scope,message) DO UPDATE SET state=excluded.state', args: [this.scope, message, value.event.album ?? null, JSON.stringify(value)] });
    }
    if (effects.consume !== undefined) statements.push({ sql: 'UPDATE tg_pending SET used=1 WHERE scope=? AND message=?', args: [this.scope, effects.consume] });
    for (const order of plan.cancelled ?? []) statements.push({ sql: 'INSERT INTO tg_orders VALUES (?,?,?) ON CONFLICT(scope,id) DO UPDATE SET state=excluded.state', args: [this.scope, order.orderId, JSON.stringify(order)] });
    if (plan.order) {
      statements.push({ sql: 'INSERT INTO tg_orders VALUES (?,?,?) ON CONFLICT(scope,id) DO UPDATE SET state=excluded.state', args: [this.scope, plan.order.orderId, JSON.stringify(plan.order)] });
      statements.push({ sql: 'INSERT OR REPLACE INTO tg_links VALUES (?,?,?,?)', args: [this.scope, plan.replyTo, plan.order.orderId, plan.order.revision] });
    }
    await this.db.batch(statements, 'write');
  }
  async beginSend(id: number) {
    const r = await this.db.execute({ sql: 'UPDATE tg_updates SET sending=1 WHERE scope=? AND id=? AND sending=0 AND done=0', args: [this.scope, id] });
    if (r.rowsAffected !== 1) throw new Error('Delivery is uncertain; inspect Telegram before recovery');
  }
  async sent(id: number, messageId: number) {
    const entry = await this.update(id);
    if (!entry?.sending) throw new Error('No uncertain send to complete');
    const next = entry.next + 1;
    const statements: Parameters<Client['batch']>[0] = [{ sql: 'UPDATE tg_updates SET sending=0,next_part=?,done=? WHERE scope=? AND id=?', args: [next, next >= entry.plan.texts.length + (entry.plan.pdfOrderId ? 1 : 0) ? 1 : 0, this.scope, id] }];
    if (entry.plan.order) statements.push({ sql: 'INSERT OR REPLACE INTO tg_links VALUES (?,?,?,?)', args: [this.scope, messageId, entry.plan.order.orderId, entry.plan.order.revision] });
    await this.db.batch(statements, 'write');
  }
  async retrySend(id: number) {
    await this.db.execute({ sql: 'UPDATE tg_updates SET sending=0 WHERE scope=? AND id=? AND sending=1', args: [this.scope, id] });
  }
  close() { this.db.close(); }
}
