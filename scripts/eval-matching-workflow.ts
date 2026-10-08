import { readFile } from 'node:fs/promises';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { configSchema } from '../src/config/schema.js';
import { DemoConnector } from '../src/connector/demo.js';
import { draftSchema } from '../src/domain/types.js';
import { createOrderWorkflow } from '../src/assistant/workflow.js';
import { createIdentityResolver } from '../src/matching/resolver.js';
import { loadMatchingConfig } from '../src/matching/config.js';
import { matchingFixtures } from '../src/matching/fixtures.js';

// Fictional records only; no FIC, Telegram, conversational model, or write calls.
async function main() {
  const matching = loadMatchingConfig();
  if (matching.mode !== 'on') throw new Error('Set JEV_MODE=on for the fictional workflow evaluation');
  const app = configSchema.parse(JSON.parse(await readFile(new URL('../config/example.json', import.meta.url), 'utf8')));
  let passed = 0;
  for (const fixture of matchingFixtures) {
    const connector = new DemoConnector();
    if (fixture.request.kind === 'product') connector.products.splice(0, 3, ...fixture.request.candidates.map(c => ({ id: c.id, code: c.code ?? '', name: c.name, description: c.description ?? '', netPrice: 12 })));
    else {
      const base = connector.clients[0]!;
      connector.clients.splice(0, connector.clients.length, ...fixture.request.candidates.map(c => ({ ...base, ...c })));
    }
    const query = fixture.request.query;
    const draft = draftSchema.parse({ clientQuery: fixture.request.kind === 'client' ? query : 'Example Studio',
      lines: [{ query: fixture.request.kind === 'product' ? query : 'Pebble hand wash 250 ml', quantity: 2 }], shippingPrice: 8 });
    const text = `Prepare an order for ${draft.clientQuery}: ${draft.lines[0]!.query}, two pieces; delivery eight euros.`;
    const storage = new LibSQLStore({ id: `jev-eval-${fixture.name}`, url: ':memory:' });
    try {
      const workflow = createOrderWorkflow(app, connector, async () => draft, undefined, createIdentityResolver(app, connector, { config: matching }));
      const mastra = new Mastra({ storage, workflows: { prepareOrder: workflow } });
      const run = await mastra.getWorkflow('prepareOrder').createRun();
      const outcome = await run.start({ inputData: { orderId: `eval-${fixture.name}`, text, date: '2026-10-08' } });
      let actual: number | string = outcome.status;
      if (outcome.status === 'success') actual = fixture.request.kind === 'client' ? outcome.result.order.client.id ?? 'missing-client' : outcome.result.order.lines[0]!.productId;
      else if (outcome.status === 'suspended') {
        const step = outcome.steps['prepare-order'];
        const payload = step && 'suspendPayload' in step ? step.suspendPayload as { decisions: { field: string; status: string }[] } : undefined;
        actual = payload?.decisions.find(d => d.field === (fixture.request.kind === 'client' ? 'client' : 'lines.0'))?.status ?? 'missing-decision';
      }
      const ok = actual === fixture.expected && connector.createCalls === 0;
      passed += Number(ok);
      console.log(JSON.stringify({ case: fixture.name, expected: fixture.expected, actual, passed: ok }));
    } finally { await storage.close(); }
  }
  console.log(JSON.stringify({ passed, total: matchingFixtures.length }));
  if (passed !== matchingFixtures.length) process.exitCode = 1;
}
main().catch(() => { console.error('Workflow matching evaluation unavailable; check JEV configuration and credentials.'); process.exitCode = 1; });
