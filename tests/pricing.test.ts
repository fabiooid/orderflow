import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import example from '../config/example.json';
import { loadConfig } from '../src/config/load.js';
import { configSchema, tierPrices } from '../src/config/schema.js';
import { DemoConnector } from '../src/connector/demo.js';
import { FattureInCloudConnector, type SdkPorts } from '../src/connector/fatture-in-cloud.js';
import { priceDiscrepancies } from '../src/domain/history.js';
import { namedAlternatives } from '../src/domain/matching.js';
import { prepareOrder } from '../src/domain/prepare.js';
import { draftSchema, type ClientOrder } from '../src/domain/types.js';
import { orderPreview } from '../src/telegram/preview.js';
import { draft, prepared } from './helpers.js';

const hospitalityForm = { schemaVersion: 1, id: 'hospitality-list', name: 'Hospitality list', priceTier: 'hospitality', columns: [{ id: 'order', heading: 'Order', value: 'quantity' }], rows: [{ code: 'DEMO-A', label: 'Amber', cells: { order: { productId: 101, netPrice: 15 } } }] };
const tiered = (clientIds = [201]) => configSchema.parse({ ...structuredClone(example), priceTiers: [{ id: 'hospitality', name: 'Hospitality', clientIds }], orderForms: [hospitalityForm] });
const prepare = (input: Partial<ReturnType<typeof draft>>, config = tiered()) => prepareOrder(draftSchema.parse({ ...draft(), ...input }), config, new DemoConnector(), '2026-01-15');

describe('price tiers', () => {
  it('charges tier clients the tier price and marks the order', async () => {
    const result = await prepare({});
    expect(result.ready && result.order.lines[0]).toMatchObject({ productId: 101, netPrice: 15 });
    expect(result.ready && result.order.priceTier).toBe('hospitality');
    const other = await prepare({}, tiered([]));
    expect(other.ready && other.order.lines[0]?.netPrice).toBe(12);
    expect(other.ready && other.order.priceTier).toBeUndefined();
  });
  it('lets a stated price, or an explicit standard tier, win', async () => {
    const stated = await prepare({ lines: [{ query: 'Amber hand wash 250 ml', quantity: 2, netPrice: 9 }] });
    expect(stated.ready && stated.order.lines[0]?.netPrice).toBe(9);
    const standard = await prepare({ priceTier: 'standard' });
    expect(standard.ready && standard.order.lines[0]?.netPrice).toBe(12);
  });
  it('asks instead of guessing when the tier has no price for a product or the tier is unknown', async () => {
    const missing = await prepare({ lines: [{ query: 'Amber hand wash 250 ml', quantity: 2 }, { query: 'Linen candle 200 g', quantity: 1 }] });
    expect(!missing.ready && missing.issues).toEqual([{ field: 'lines.1.netPrice', message: expect.stringContaining('No Hospitality price for Linen candle 200 g: confirm the standard price 20') }]);
    const unknown = await prepare({ priceTier: 'wholesale' });
    expect(!unknown.ready && unknown.issues.map(i => i.field)).toEqual(['priceTier']);
  });
  it('validates tiers and forms together', () => {
    const parse = (extra: object) => configSchema.safeParse({ ...structuredClone(example), ...extra }).success;
    expect(parse({ orderForms: [hospitalityForm] })).toBe(false);
    expect(parse({ priceTiers: [{ id: 'a', name: 'A', clientIds: [1] }, { id: 'b', name: 'B', clientIds: [1] }] })).toBe(false);
    expect(parse({ priceTiers: [{ id: 'hospitality', name: 'H', clientIds: [] }], orderForms: [{ ...hospitalityForm, rows: [{ code: '', label: 'x', cells: { tester: { productId: 1 } } }] }] })).toBe(false);
    expect(tierPrices(tiered(), 'hospitality')).toEqual(new Map([[101, 15]]));
  });
  it('loads order forms listed as file paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forms-'));
    try {
      await writeFile(join(dir, 'form.json'), JSON.stringify(hospitalityForm));
      await writeFile(join(dir, 'config.json'), JSON.stringify({ ...example, priceTiers: [{ id: 'hospitality', name: 'H', clientIds: [] }], orderForms: [join(dir, 'form.json')] }));
      expect((await loadConfig(join(dir, 'config.json'))).orderForms[0]?.id).toBe('hospitality-list');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

it('offers exactly the named products for an "A oppure B" line', async () => {
  const products = await new DemoConnector().listProducts();
  expect(namedAlternatives('da chiarire (A1, order): Amber hand wash 250 ml oppure Linen candle 200 g', products).map(p => p.id)).toEqual([101, 103]);
  expect(namedAlternatives('Amber hand wash 250 ml or something else', products)).toEqual([]);
  const result = await prepare({ lines: [{ query: 'Amber hand wash 250 ml oppure Linen candle 200 g', quantity: 1 }] }, tiered([]));
  expect(!result.ready && result.issues[0]?.candidates).toEqual([{ id: 101, label: 'Amber hand wash 250 ml' }, { id: 103, label: 'Linen candle 200 g' }]);
});

describe('previous orders', () => {
  const earlier = (number: string, date: string, lines: Partial<ClientOrder['lines'][number]>[]): ClientOrder =>
    ({ id: Number(number), number, date, lines: lines.map(l => ({ code: '', name: '', quantity: 1, netPrice: 0, discountPercent: 0, ...l })) });
  it('compares unit prices after discount with the latest paid line, skipping free ones', async () => {
    const order = await prepared(); // Amber at €12 with 10% off, delivery at €8 with no discount.
    const found = priceDiscrepancies(order, [
      earlier('9', '2026-01-10', [{ productId: 101, netPrice: 0 }, { productId: 900, netPrice: 8 }]),
      earlier('8', '2025-12-01', [{ productId: 101, netPrice: 12, discountPercent: 20 }]),
      earlier('7', '2025-11-01', [{ productId: 101, netPrice: 30 }]),
    ]);
    expect(found).toEqual([{ name: 'Amber hand wash 250 ml', now: 10.8, before: 9.6, order: { number: '8', date: '2025-12-01' } }]);
  });
  it('shows the price list and differences in the summary without blocking it', async () => {
    const order = await prepared();
    const text = orderPreview(order, { net: 1, vat: 1, gross: 2 }, true, true, {
      tierName: 'Hospitality', warnings: ['Prezzi Hospitality, ma il cliente non è nella lista Hospitality'],
      discrepancies: [{ name: 'Delivery', now: 15, before: 12, order: { number: '137', date: '2026-10-06' } }],
    });
    expect(text).toContain('🏷️ Prezzi: listino Hospitality');
    expect(text).toContain('⚠️ Da verificare\n• Prezzi Hospitality, ma il cliente non è nella lista Hospitality\n• Delivery: ora €15,00, ordine precedente €12,00 (#137, 06/10/2026)');
    expect(text).toContain('Conferma e salva');
  });
  it('reads a client\'s orders from Fatture in Cloud with a filter, never other clients\' orders', async () => {
    const listIssuedDocuments = vi.fn().mockResolvedValue({ data: { data: [
      { id: 5, type: 'order', number: 137, date: '2026-10-06', entity: { id: 42 }, items_list: [{ product_id: 7, code: 'MS038', name: 'Refill', qty: 1, net_price: 80, discount: 0 }] },
      { id: 6, type: 'order', number: 136, date: '2026-10-02', entity: { id: 43 }, items_list: [] },
    ] } });
    const connector = new FattureInCloudConnector(1, { documents: { listIssuedDocuments } } as unknown as SdkPorts);
    expect(await connector.listClientOrders(42, 3)).toEqual([{ id: 5, number: '137', date: '2026-10-06', lines: [{ productId: 7, code: 'MS038', name: 'Refill', quantity: 1, netPrice: 80, discountPercent: 0 }] }]);
    expect(listIssuedDocuments).toHaveBeenCalledWith(1, 'order', undefined, 'detailed', '-date', 1, 5, 'entity.id = 42');
  });
});
