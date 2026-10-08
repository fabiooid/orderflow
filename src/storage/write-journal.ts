import { createHash } from 'node:crypto';
import { createClient, type Client } from '@libsql/client';

function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export class ReconciliationRequired extends Error {}
/** Failure before any write was attempted. Safe to retry or revise the draft. */
export class PreflightFailed extends Error {
  constructor(readonly needsReview = false) { super('Preflight failed before any write'); }
}

/** Local duplicate protection. It does not assert remote exactly-once semantics. */
export class WriteJournal {
  readonly #db: Client;
  constructor(url: string) { this.#db = createClient({ url }); }
  async init() {
    await this.#db.execute('CREATE TABLE IF NOT EXISTS connector_writes (operation_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, result TEXT)');
    await this.#db.execute('CREATE TABLE IF NOT EXISTS write_recovery (id INTEGER PRIMARY KEY, operation_key TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, recovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  }
  async inspect(prefix: string) {
    return (await this.#db.execute({ sql: 'SELECT operation_key,status FROM connector_writes WHERE operation_key = ? OR substr(operation_key,1,?) = ?', args: [prefix, prefix.length + 1, `${prefix}:`] })).rows;
  }
  /** Operator-only recovery, after verifying the remote record. Never performs a remote write. */
  async resolve<T>(key: string, payload: unknown, result: T, reason: string) {
    if (reason.trim().length < 10) throw new Error('Record the remote verification evidence');
    const fingerprint = createHash('sha256').update(canonical(payload)).digest('hex');
    const record = (await this.#db.execute({ sql: 'SELECT * FROM connector_writes WHERE operation_key=?', args: [key] })).rows[0];
    if (!record || record.fingerprint !== fingerprint) throw new Error('Recovery payload does not match the attempted write');
    if (record.status === 'completed') {
      if (canonical(JSON.parse(String(record.result))) !== canonical(result)) throw new Error('Recovery conflicts with a completed write');
      return;
    }
    await this.#db.batch([
      { sql: "UPDATE connector_writes SET status='completed',result=? WHERE operation_key=?", args: [JSON.stringify(result), key] },
      { sql: "INSERT INTO write_recovery(operation_key,action,reason) VALUES (?,'found',?)", args: [key, reason] },
    ], 'write');
  }
  /** Explicit human verification of absence is required; completed child writes are retained. */
  async approveRetry(prefix: string, reason: string) {
    if (reason.trim().length < 10) throw new Error('Record the remote verification evidence');
    const records = await this.inspect(prefix);
    if (!records.length || records.some(r => r.operation_key === prefix && r.status === 'completed') || records.some(r => String(r.operation_key).endsWith(':save') && r.status === 'completed')) throw new Error('A completed or missing write cannot be reset');
    await this.#db.batch(records.filter(r => r.status !== 'completed').flatMap(r => [
      { sql: "UPDATE connector_writes SET status='retry-approved' WHERE operation_key=?", args: [String(r.operation_key)] },
      { sql: "INSERT INTO write_recovery(operation_key,action,reason) VALUES (?,'verified-absent',?)", args: [String(r.operation_key), reason] },
    ]), 'write');
  }
  async replay<T>(key: string, payload: unknown): Promise<{ result: T } | undefined> {
    const record = (await this.#db.execute({ sql: 'SELECT * FROM connector_writes WHERE operation_key = ?', args: [key] })).rows[0];
    if (!record) return undefined;
    const fingerprint = createHash('sha256').update(canonical(payload)).digest('hex');
    if (record.fingerprint === fingerprint && record.status === 'retry-approved') return undefined;
    if (record.fingerprint !== fingerprint || record.status !== 'completed') throw new ReconciliationRequired('Previous write needs reconciliation before retrying or changing its payload');
    return { result: JSON.parse(String(record.result)) as T };
  }
  async once<T>(key: string, payload: unknown, action: () => Promise<T>): Promise<T> {
    const fingerprint = createHash('sha256').update(canonical(payload)).digest('hex');
    const insert = await this.#db.execute({ sql: "INSERT OR IGNORE INTO connector_writes (operation_key, fingerprint, status) VALUES (?, ?, 'pending')", args: [key, fingerprint] });
    if (insert.rowsAffected === 0) {
      const record = (await this.#db.execute({ sql: 'SELECT * FROM connector_writes WHERE operation_key = ?', args: [key] })).rows[0]!;
      if (record.fingerprint !== fingerprint) throw new Error('Operation key reused for a different payload; create a new revision');
      if (record.status === 'completed') return JSON.parse(String(record.result)) as T;
      if (record.status !== 'retry-approved' || (await this.#db.execute({ sql: "UPDATE connector_writes SET status='pending' WHERE operation_key=? AND status='retry-approved'", args: [key] })).rowsAffected !== 1) throw new ReconciliationRequired('Previous write is pending or uncertain; reconcile with the remote service before retrying');
    }
    try {
      const result = await action();
      await this.#db.execute({ sql: "UPDATE connector_writes SET status = 'completed', result = ? WHERE operation_key = ?", args: [JSON.stringify(result), key] });
      return result;
    } catch {
      await this.#db.execute({ sql: "UPDATE connector_writes SET status = 'uncertain' WHERE operation_key = ?", args: [key] });
      // Do not expose raw SDK errors that may include authenticated request headers.
      throw new ReconciliationRequired('Write did not complete reliably; inspect the remote state before retrying');
    }
  }
  close() { this.#db.close(); }
}
