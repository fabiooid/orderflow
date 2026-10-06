import { createHash } from 'node:crypto';
import { createClient, type Client } from '@libsql/client';

function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export class ReconciliationRequired extends Error {}

/** Local duplicate protection. It does not assert remote exactly-once semantics. */
export class WriteJournal {
  readonly #db: Client;
  constructor(url: string) { this.#db = createClient({ url }); }
  async init() {
    await this.#db.execute('CREATE TABLE IF NOT EXISTS connector_writes (operation_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, result TEXT)');
  }
  async once<T>(key: string, payload: unknown, action: () => Promise<T>): Promise<T> {
    const fingerprint = createHash('sha256').update(canonical(payload)).digest('hex');
    const insert = await this.#db.execute({ sql: "INSERT OR IGNORE INTO connector_writes (operation_key, fingerprint, status) VALUES (?, ?, 'pending')", args: [key, fingerprint] });
    if (insert.rowsAffected === 0) {
      const record = (await this.#db.execute({ sql: 'SELECT * FROM connector_writes WHERE operation_key = ?', args: [key] })).rows[0]!;
      if (record.fingerprint !== fingerprint) throw new Error('Operation key reused for a different payload; create a new revision');
      if (record.status === 'completed') return JSON.parse(String(record.result)) as T;
      throw new ReconciliationRequired('Previous write is pending or uncertain; reconcile with the remote service before retrying');
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
