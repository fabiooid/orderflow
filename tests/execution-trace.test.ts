import { expect, it } from 'vitest';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { Observability, MastraStorageExporter } from '@mastra/observability';
import { traceChannelTurn, tracedConnector, traceOperation, tracingContext } from '../src/assistant/execution-trace.js';
import { createDraftApi } from '../src/assistant/drafts.js';
import { createIdentityResolver } from '../src/matching/resolver.js';
import { matchingConfigSchema } from '../src/matching/config.js';
import { DemoConnector } from '../src/connector/demo.js';
import { config, draft } from './helpers.js';

it('persists order API, FIC and delivery spans under one native Mastra turn trace', async () => {
  const storage = new LibSQLStore({ id: 'trace-test', url: ':memory:' });
  const observability = new Observability({ configs: { default: { serviceName: 'test', exporters: [new MastraStorageExporter()] } } });
  const connector = tracedConnector(new DemoConnector());
  const drafts = createDraftApi(config(), connector, createIdentityResolver(config(), connector, { config: matchingConfigSchema.parse({ mode: 'off' }) }));
  const mastra = new Mastra({ storage, observability });
  let traceId = '';
  try {
    await traceChannelTurn(observability.getDefaultInstance(), 41, async () => {
      traceId = tracingContext().currentSpan!.traceId;
      expect((await drafts.order(draft(), { orderId: 'test', revision: 1, operatorText: 'Two soaps' }, '2026-01-15')).status).toBe('ready');
      await traceOperation('Telegram deliver text', async () => ({ message_id: 1 }));
      await expect(traceOperation('Simulated failure', async () => { throw new Error('SECRET-SDK-HEADER'); })).rejects.toThrow();
      return { orderId: 'test', state: 'ready' };
    });
    await observability.flush();
    const traces = await storage.getStore('observability');
    const trace = await traces!.getTrace({ traceId });
    const root = trace!.spans.find(span => span.name === 'Channel turn')!;
    expect(root.output).toEqual({ orderId: 'test', state: 'ready' });
    expect(root.metadata).toMatchObject({ updateId: 41, orderId: 'test', state: 'ready' });
    expect(trace!.spans.map(s => s.name)).toEqual(expect.arrayContaining(['Resolve identities', 'Prepare order', 'FIC list products', 'FIC calculate totals', 'Telegram deliver text']));
    expect(trace!.spans.filter(s => s.spanId !== root.spanId).every(s => s.parentSpanId)).toBe(true);
    expect(JSON.stringify(trace)).not.toContain('SECRET-SDK-HEADER');
  } finally { await mastra.shutdown(); await storage.close(); }
});
