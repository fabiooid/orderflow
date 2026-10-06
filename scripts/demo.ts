import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { loadConfig } from '../src/config/load.js';
import { DemoConnector } from '../src/connector/demo.js';
import { createOrderWorkflow } from '../src/assistant/workflow.js';
import { draftSchema } from '../src/domain/types.js';
import { savePreparedOrder } from '../src/assistant/save.js';
import { WriteJournal } from '../src/storage/write-journal.js';

const dir = await mkdtemp(join(tmpdir(), 'fic-demo-'));
const storage = new LibSQLStore({ id: 'demo-storage', url: `file:${join(dir, 'mastra.db')}` });
const journal = new WriteJournal(`file:${join(dir, 'writes.db')}`);
try {
  const config = await loadConfig('config/example.json');
  const connector = new DemoConnector();
  const draft = draftSchema.parse({ clientQuery: 'Example Studio', lines: [{ query: 'Amber 250', quantity: 2 }], discountPercent: 10 });
  // Scripted extraction makes this an offline workflow demo, not a model-quality test.
  const workflow = createOrderWorkflow(config, connector, async () => draft);
  const mastra = new Mastra({ storage, workflows: { prepareOrder: workflow } });
  const run = await mastra.getWorkflow('prepareOrder').createRun();
  const initial = await run.start({ inputData: { orderId: 'demo-1', date: '2026-01-15', text: 'Two Amber 250 for Example Studio, discount 10%' } });
  console.log('Offline demo: scripted extraction, fictional catalogue, no API calls.');
  console.log('First pass:', initial.status, '(ambiguous variant and delivery price require clarification)');
  if (initial.status !== 'suspended') throw new Error('Expected clarification');
  const result = await run.resume({ step: 'prepare-order', resumeData: { draft: { ...draft, lines: [{ query: 'Amber hand wash 250 ml', quantity: 2 }], shippingPrice: 8 } } });
  if (result.status !== 'success') throw new Error(`Unexpected result: ${result.status}`);
  console.log('Resolved order:', result.result.order.lines.map(l => `${l.quantity} × ${l.name} (${l.discountPercent}% discount)`).join('; '));
  console.log('Totals:', result.result.totals);
  await journal.init();
  const saved = await savePreparedOrder('fictional-demo:demo-1', result.result.order, connector, journal);
  await savePreparedOrder('fictional-demo:demo-1', result.result.order, connector, journal);
  console.log('Simulated saved order:', saved.number, '| create calls after retry:', connector.createCalls);
  console.log('No real order or PDF was created; Telegram is not connected.');
} finally {
  journal.close();
  await storage.close();
  await rm(dir, { recursive: true, force: true });
}
