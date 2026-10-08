import { expect, it } from 'vitest';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { Observability, MastraStorageExporter } from '@mastra/observability';
import { traceTelegramTurn, tracedConnector, traceOperation, tracingContext } from '../src/assistant/execution-trace.js';
import { createOrderWorkflow } from '../src/assistant/workflow.js';
import { DemoConnector } from '../src/connector/demo.js';
import { config, draft } from './helpers.js';

it('persists workflow, API and delivery spans under one native Mastra turn trace', async () => {
  const storage = new LibSQLStore({ id: 'trace-test', url: ':memory:' });
  const observability = new Observability({ configs: { default: { serviceName: 'test', exporters: [new MastraStorageExporter()] } } });
  const connector = tracedConnector(new DemoConnector());
  const workflow = createOrderWorkflow(config(), connector, async () => draft());
  const mastra = new Mastra({ storage, observability, workflows: { prepareOrder: workflow } });
  let traceId = '';
  try {
    await traceTelegramTurn(observability.getDefaultInstance(), 41, async () => {
      traceId = tracingContext().currentSpan!.traceId;
      const run = await mastra.getWorkflow('prepareOrder').createRun();
      expect((await run.start({ tracingContext: tracingContext(), inputData: { orderId: 'test', text: 'Two soaps', date: '2026-01-15' } })).status).toBe('success');
      await traceOperation('Telegram deliver text', async () => ({ message_id: 1 }));
      await expect(traceOperation('Simulated failure', async () => { throw new Error('SECRET-SDK-HEADER'); })).rejects.toThrow();
      return { orderId: 'test', state: 'ready' };
    });
    await observability.flush();
    const traces = await storage.getStore('observability');
    const trace = await traces!.getTrace({ traceId });
    const root = trace!.spans.find(span => span.name === 'Telegram turn')!;
    expect(root.output).toEqual({ orderId: 'test', state: 'ready' });
    expect(root.metadata).toMatchObject({ updateId: 41, orderId: 'test' });
    expect(trace!.spans.map(s => s.name)).toEqual(expect.arrayContaining(['FIC list products', 'FIC calculate totals', 'Telegram deliver text']));
    expect(trace!.spans.some(s => s.spanType === 'workflow_run')).toBe(true);
    expect(trace!.spans.filter(s => s.spanId !== root.spanId).every(s => s.parentSpanId)).toBe(true);
    expect(JSON.stringify(trace)).not.toContain('SECRET-SDK-HEADER');
  } finally { await mastra.shutdown(); await storage.close(); }
});
