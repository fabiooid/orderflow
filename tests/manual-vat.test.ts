import { expect, it } from 'vitest';
import { config, draft } from './helpers.js';
import { DemoConnector } from '../src/connector/demo.js';
import { prepareOrder } from '../src/domain/prepare.js';

it('requires an explicit matching manual VAT confirmation and rejects invalid or stale checks', async () => {
  const c = config();
  c.vatRules = [{ id: 'manual-test', priority: 1, rate: 0, requireValidVat: true }];
  c.invoicing.vat = [{ ruleId: 'manual-test', vatId: 49, nature: 'N3.2' }];
  const connector = new DemoConnector();
  const client = (await connector.listClients())[0]!;
  const d = draft();
  expect((await prepareOrder(d, c, connector, '2026-01-15')).ready).toBe(false);
  d.manualVatCheck = { country: client.country, vatNumber: client.vatNumber!, status: 'valid' };
  expect((await prepareOrder(d, c, connector, '2026-01-15')).ready).toBe(true);
  d.manualVatCheck.status = 'invalid';
  expect((await prepareOrder(d, c, connector, '2026-01-15')).ready).toBe(false);
  d.manualVatCheck.status = 'valid'; d.manualVatCheck.vatNumber = 'DIFFERENT';
  expect((await prepareOrder(d, c, connector, '2026-01-15')).ready).toBe(false);
});

it('accepts Fatture in Cloud default VAT ID zero', async () => {
  const c = config(); c.invoicing.vat = c.invoicing.vat.map(item => ({ ...item, vatId: 0 }));
  const result = await prepareOrder(draft(), c, new DemoConnector(), '2026-01-15');
  expect(result.ready && result.order.lines.every(l => l.vatId === 0)).toBe(true);
});
