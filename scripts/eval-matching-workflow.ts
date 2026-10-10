import { readFile } from 'node:fs/promises';
import { configSchema } from '../src/config/schema.js';
import { DemoConnector } from '../src/connector/demo.js';
import { draftSchema } from '../src/domain/types.js';
import { createDraftApi } from '../src/assistant/drafts.js';
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
    const drafts = createDraftApi(app, connector, createIdentityResolver(app, connector, { config: matching }));
    const outcome = await drafts.order(draft, { orderId: `eval-${fixture.name}`, revision: 1, operatorText: text }, '2026-10-08');
    const field = fixture.request.kind === 'client' ? 'client' : 'lines.0';
    const actual: string = outcome.status === 'ready'
      ? fixture.request.kind === 'client' ? outcome.order.client.id ?? 'missing-client' : outcome.order.lines[0]!.productId
      : outcome.decisions.find(d => d.field === field)?.status ?? 'missing-decision';
    const ok = actual === fixture.expected && connector.createCalls === 0;
    passed += Number(ok);
    console.log(JSON.stringify({ case: fixture.name, expected: fixture.expected, actual, passed: ok }));
  }
  console.log(JSON.stringify({ passed, total: matchingFixtures.length }));
  if (passed !== matchingFixtures.length) process.exitCode = 1;
}
main().catch(() => { console.error('Workflow matching evaluation unavailable; check JEV configuration and credentials.'); process.exitCode = 1; });
