import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { expect, it, vi } from 'vitest';
import { createOrderWorkflow } from '../src/assistant/workflow.js';
import { createOrderAgent, memoryScope, sharedKnowledgeSchema } from '../src/assistant/agent.js';
import { exactOrderScorer } from '../src/assistant/scorers.js';
import { DemoConnector } from '../src/connector/demo.js';
import { config, draft } from './helpers.js';

it('persists clarification and resumes after reconstructing Mastra without re-extraction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fic-workflow-'));
  const url = `file:${join(dir, 'mastra.db')}`;
  let storage = new LibSQLStore({ id: 'first', url });
  try {
    const connector = new DemoConnector();
    const ambiguous = { ...draft(), lines: [{ query: 'Pebble 250', quantity: 2 }] };
    const first = createOrderWorkflow(config(), connector, async () => ambiguous);
    const mastra = new Mastra({ storage, workflows: { prepareOrder: first } });
    const run = await mastra.getWorkflow('prepareOrder').createRun({ runId: 'resume-test' });
    const paused = await run.start({ inputData: { orderId: 'one', text: 'Two Pebble 250', date: '2026-01-15' } });
    expect(paused.status).toBe('suspended');
    expect(connector.createCalls).toBe(0);
    await storage.close();
    storage = new LibSQLStore({ id: 'second', url });
    const extractor = vi.fn().mockRejectedValue(new Error('Must not repeat extraction'));
    const second = createOrderWorkflow(config(), connector, extractor);
    const restarted = new Mastra({ storage, workflows: { prepareOrder: second } });
    const resumed = await restarted.getWorkflow('prepareOrder').createRun({ runId: 'resume-test' });
    const result = await resumed.resume({ step: 'prepare-order', resumeData: { draft: draft() } });
    expect(result.status).toBe('success');
    if (result.status === 'success') expect(result.result.totals.gross).toBe(36.11);
    expect(extractor).not.toHaveBeenCalled();
    expect(connector.createCalls).toBe(0);
  } finally { await storage.close(); await rm(dir, { recursive: true, force: true }); }
}, 20000);

it('uses Mastra resource memory for shared confirmed aliases without storing prices', async () => {
  const storage = new LibSQLStore({ id: 'memory', url: ':memory:' });
  try {
    const c = config();
    const { memory } = createOrderAgent(c, new DemoConnector(), storage);
    const one = memoryScope(c, 'one'); const two = memoryScope(c, 'two');
    await memory.createThread({ threadId: one.thread, resourceId: one.resource });
    await memory.createThread({ threadId: two.thread, resourceId: two.resource });
    const confirmed = sharedKnowledgeSchema.parse({ aliases: [{ phrase: 'small wash', productId: 101, sourceMessage: 'demo-message', confirmedBy: 'demo-operator' }] });
    await memory.updateWorkingMemory({ threadId: one.thread, resourceId: one.resource, workingMemory: JSON.stringify(confirmed) });
    expect(await memory.getWorkingMemory({ threadId: two.thread, resourceId: two.resource })).toContain('small wash');
    expect(memoryScope({ ...c, deploymentId: 'other' }, 'one').resource).not.toBe(one.resource);
    expect(() => sharedKnowledgeSchema.parse({ ...confirmed, prices: { item: 1 } })).toThrow();
  } finally { await storage.close(); }
}, 20000);

it('scores exact order outcomes through Mastra without a judge model', async () => {
  const reference = { productIds: [101, 900], quantities: [2, 1], totals: { net: 29.6, vat: 6.51, gross: 36.11 } };
  expect((await exactOrderScorer.run({ input: reference, output: reference })).score).toBe(1);
  expect((await exactOrderScorer.run({ input: reference, output: { ...reference, quantities: [3, 1] } })).score).toBe(0);
});
