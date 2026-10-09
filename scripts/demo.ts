import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { DemoConnector } from '../src/connector/demo.js';
import { createDraftApi } from '../src/assistant/drafts.js';
import { createIdentityResolver } from '../src/matching/resolver.js';
import { matchingConfigSchema } from '../src/matching/config.js';
import { draftSchema } from '../src/domain/types.js';
import { savePreparedOrder } from '../src/assistant/save.js';
import { WriteJournal } from '../src/storage/write-journal.js';

const dir = await mkdtemp(join(tmpdir(), 'fic-demo-'));
const journal = new WriteJournal(`file:${join(dir, 'writes.db')}`);
try {
  const config = await loadConfig('config/example.json');
  const connector = new DemoConnector();
  // Scripted drafts and no identity model make this an offline demo of the order API, not a model-quality test.
  const drafts = createDraftApi(config, connector, createIdentityResolver(config, connector, { config: matchingConfigSchema.parse({ mode: 'off' }) }));
  const context = { orderId: 'demo-1', revision: 1, operatorText: 'Two Amber 250 for Example Studio, discount 10%' };
  const draft = draftSchema.parse({ clientQuery: 'Example Studio', lines: [{ query: 'Amber 250', quantity: 2 }], discountPercent: 10 });
  const initial = await drafts.order(draft, context, '2026-01-15');
  console.log('Offline demo: scripted drafts, fictional catalogue, no API calls.');
  console.log('First pass:', initial.status, '(ambiguous variant and delivery price require clarification)');
  if (initial.status !== 'needs') throw new Error('Expected clarification');
  const result = await drafts.order({ ...draft, lines: [{ query: 'Amber hand wash 250 ml', quantity: 2 }], shippingPrice: 8 }, { ...context, revision: 2 }, '2026-01-15');
  if (result.status !== 'ready') throw new Error(`Unexpected result: ${result.status}`);
  console.log('Resolved order:', result.order.lines.map(l => `${l.quantity} × ${l.name} (${l.discountPercent}% discount)`).join('; '));
  console.log('Totals:', result.totals);
  await journal.init();
  const saved = await savePreparedOrder('fictional-demo:demo-1', result.order, connector, journal);
  await savePreparedOrder('fictional-demo:demo-1', result.order, connector, journal);
  console.log('Simulated saved order:', saved.number, '| create calls after retry:', connector.createCalls);
  console.log('No real order or PDF was created; Telegram is not connected.');
} finally {
  journal.close();
  await rm(dir, { recursive: true, force: true });
}
