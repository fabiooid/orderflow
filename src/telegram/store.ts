import { createClient, type Client } from '@libsql/client';
import type { OrderDraft, PreparedOrder, Totals, SavedOrder } from '../domain/types.js';
import type { OrderLink } from './adapter.js';
export type Conversation = { orderId: string; startedBy?: string; startedAt?: string; kind?: 'customer' | 'catalogue'; revision: number; runId?: string; status: 'new' | 'suspended' | 'ready' | 'reviewed' | 'saving' | 'saved' | 'cancelled'; prepared?: PreparedOrder; totals?: Totals; savedOrder?: SavedOrder; draft: OrderDraft; questions: string; policy: string };
export type ReplyPlan = { incomingText?: string; senderId?: string; receivedAt?: string; texts: string[]; pdfOrderId?: number; order?: Conversation; replyTo: number };

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
    ], 'write');
  }
  async offset() { return Number((await this.db.execute({ sql: 'SELECT offset FROM tg_offsets WHERE scope=?', args: [this.scope] })).rows[0]?.offset ?? 0); }
  async advance(offset: number) { await this.db.execute({ sql: 'INSERT INTO tg_offsets VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET offset=MAX(offset,excluded.offset)', args: [this.scope, offset] }); }
  async order(id: string): Promise<Conversation | undefined> {
    const row = (await this.db.execute({ sql: 'SELECT state FROM tg_orders WHERE scope=? AND id=?', args: [this.scope, id] })).rows[0];
    return row ? JSON.parse(String(row.state)) : undefined;
  }
  /** Newest wins: starting a new empty request replaces older ones for plain follow-up text. */
  async awaitingDetails(senderId: string): Promise<OrderLink | undefined> {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const row = (await this.db.execute({
      sql: `SELECT id FROM tg_orders WHERE scope=? AND json_extract(state,'$.startedBy')=? AND json_extract(state,'$.status')='new'
        AND json_extract(state,'$.revision')=0 AND json_extract(state,'$.kind') IS NOT 'catalogue' AND json_extract(state,'$.startedAt')>?
        ORDER BY json_extract(state,'$.startedAt') DESC, rowid DESC LIMIT 1`,
      args: [this.scope, senderId, since],
    })).rows[0];
    return row ? { orderId: String(row.id), revision: 0 } : undefined;
  }
  async latestRequest(senderId: string): Promise<Conversation | undefined> {
    const row = (await this.db.execute({
      sql: `SELECT state FROM tg_orders WHERE scope=? AND json_extract(state,'$.startedBy')=? AND json_extract(state,'$.status')!='cancelled'
        AND json_extract(state,'$.kind') IS NOT 'catalogue' ORDER BY json_extract(state,'$.startedAt') DESC, rowid DESC LIMIT 1`,
      args: [this.scope, senderId],
    })).rows[0];
    return row ? JSON.parse(String(row.state)) : undefined;
  }
  async activeRequest(): Promise<Conversation | undefined> {
    const rows = (await this.db.execute({sql: "SELECT state FROM tg_orders WHERE scope=? ORDER BY rowid DESC", args:[this.scope]})).rows;
    return rows.map(r => JSON.parse(String(r.state)) as Conversation).find(c => c.kind !== 'catalogue' && ['new','suspended','ready','saving'].includes(c.status));
  }
  async link(message: number): Promise<OrderLink | undefined> {
    const row = (await this.db.execute({ sql: 'SELECT order_id,revision FROM tg_links WHERE scope=? AND message=?', args: [this.scope, message] })).rows[0];
    return row ? { orderId: String(row.order_id), revision: Number(row.revision) } : undefined;
  }
  async update(id: number) {
    const row = (await this.db.execute({ sql: 'SELECT * FROM tg_updates WHERE scope=? AND id=?', args: [this.scope, id] })).rows[0];
    return row ? { plan: JSON.parse(String(row.plan)) as ReplyPlan, next: Number(row.next_part), sending: Boolean(row.sending), done: Boolean(row.done) } : undefined;
  }
  async plan(id: number, plan: ReplyPlan) {
    const statements: Parameters<Client['batch']>[0] = [{ sql: 'INSERT INTO tg_updates(scope,id,plan) VALUES (?,?,?)', args: [this.scope, id, JSON.stringify(plan)] }];
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
