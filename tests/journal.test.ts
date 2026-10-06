import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WriteJournal, ReconciliationRequired } from '../src/storage/write-journal.js';
import { DemoConnector } from '../src/connector/demo.js';
import { savePreparedOrder } from '../src/assistant/save.js';
import { prepared } from './helpers.js';

describe('persistent external-write journal', () => {
  it('returns the saved response across restart without creating twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fic-journal-'));
    const url = `file:${join(dir, 'journal.db')}`;
    const connector = new DemoConnector();
    const order = await prepared();
    let journal = new WriteJournal(url);
    try {
      await journal.init();
      const saved = await savePreparedOrder('business:order-1', order, connector, journal);
      journal.close(); journal = new WriteJournal(url); await journal.init();
      expect(await savePreparedOrder('business:order-1', order, connector, journal)).toEqual(saved);
      expect(connector.createCalls).toBe(1);
      await expect(savePreparedOrder('business:order-1', { ...order, notes: 'changed' }, connector, journal)).rejects.toThrow(/different payload/);
    } finally { journal.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('blocks a blind retry after an uncertain remote result', async () => {
    const journal = new WriteJournal(':memory:'); await journal.init();
    const action = vi.fn().mockRejectedValue(new Error('timeout with secret-token in raw request'));
    try {
      await expect(journal.once('key', { x: 1 }, action)).rejects.toThrow(ReconciliationRequired);
      await expect(journal.once('key', { x: 1 }, action)).rejects.toThrow(/uncertain/);
      expect(action).toHaveBeenCalledTimes(1);
    } finally { journal.close(); }
  });
  it('prevents concurrent execution for the same key', async () => {
    const journal = new WriteJournal(':memory:'); await journal.init();
    let complete!: (value: number) => void;
    const action = vi.fn(() => new Promise<number>(resolve => { complete = resolve; }));
    try {
      const first = journal.once('concurrent', {}, action);
      await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
      await expect(journal.once('concurrent', {}, action)).rejects.toThrow(ReconciliationRequired);
      complete(42); expect(await first).toBe(42);
    } finally { journal.close(); }
  });
});
