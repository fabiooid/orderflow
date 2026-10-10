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
import { orderPreview } from '../src/channel/preview.js';
import { draft, prepared } from './helpers.js';

const tradeForm = { schemaVersion: 1, id: 'trade-list', name: 'Trade list', priceTier: 'trade', columns: [{ id: 'order', heading: 'Order', value: 'quantity' }], rows: [{ code: 'DEMO-A', label: 'Pebble', cells: { order: { productId: 101, netPrice: 15 } } }] };
const tiered = (clientIds = [201]) => configSchema.parse({ ...structuredClone(example), priceTiers: [{ id: 'trade', name: 'Trade', clientIds }], orderForms: [tradeForm] });
const prepare = (input: Partial<ReturnType<typeof draft>>, config = tiered()) => prepareOrder(draftSchema.parse({ ...draft(), ...input }), config, new DemoConnector(), '2026-01-15');

describe('price tiers', () => {
  it('uses API prices even for clients with legacy configured template prices', async () => {
    const result = await prepare({});
    expect(result.ready && result.order.lines[0]).toMatchObject({ productId: 101, netPrice: 12 });
    expect(result.ready && result.order.priceTier).toBeUndefined();
    const other = await prepare({}, tiered([]));
    expect(other.ready && other.order.lines[0]?.netPrice).toBe(12);
    expect(other.ready && other.order.priceTier).toBeUndefined();
  });
  it('lets a stated price, or an explicit standard tier, win', async () => {
    const stated = await prepare({ lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2, netPrice: 9 }] });
    expect(stated.ready && stated.order.lines[0]?.netPrice).toBe(9);
    const standard = await prepare({ priceTier: 'standard' });
    expect(standard.ready && standard.order.lines[0]?.netPrice).toBe(12);
  });
  it('does not require template prices, but asks about explicitly requested unsupported price lists', async () => {
    const missing = await prepare({ lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }, { query: 'Linen candle 200 g', quantity: 1 }] });
    expect(missing.ready && missing.order.lines[1]?.netPrice).toBe(20);
    const unknown = await prepare({ priceTier: 'wholesale' });
    expect(!unknown.ready && unknown.issues.map(i => i.field)).toEqual(['priceTier']);
  });
  it('validates tiers and forms together', () => {
    const parse = (extra: object) => configSchema.safeParse({ ...structuredClone(example), ...extra }).success;
    expect(parse({ orderForms: [tradeForm] })).toBe(false);
    expect(parse({ priceTiers: [{ id: 'a', name: 'A', clientIds: [1] }, { id: 'b', name: 'B', clientIds: [1] }] })).toBe(false);
    expect(parse({ priceTiers: [{ id: 'trade', name: 'H', clientIds: [] }], orderForms: [{ ...tradeForm, rows: [{ code: '', label: 'x', cells: { tester: { productId: 1 } } }] }] })).toBe(false);
    expect(tierPrices(tiered(), 'trade')).toEqual(new Map([[101, 15]]));
  });
  it('loads order forms listed as file paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forms-'));
    try {
      await writeFile(join(dir, 'form.json'), JSON.stringify(tradeForm));
      await writeFile(join(dir, 'config.json'), JSON.stringify({ ...example, priceTiers: [{ id: 'trade', name: 'H', clientIds: [] }], orderForms: [join(dir, 'form.json')] }));
      expect((await loadConfig(join(dir, 'config.json'))).orderForms[0]?.id).toBe('trade-list');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('loads project-relative order forms when Studio changes the working directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forms-'));
    try {
      await writeFile(join(dir, 'form.json'), JSON.stringify(tradeForm));
      await writeFile(join(dir, 'config.json'), JSON.stringify({ ...example, priceTiers: [{ id: 'trade', name: 'H', clientIds: [] }], orderForms: ['form.json'] }));
      expect((await loadConfig('config.json', dir)).orderForms[0]?.id).toBe('trade-list');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

it('offers exactly the named products for an "A oppure B" line', async () => {
  const products = await new DemoConnector().listProducts();
  expect(namedAlternatives('da chiarire (A1, order): Pebble hand wash 250 ml oppure Linen candle 200 g', products).map(p => p.id)).toEqual([101, 103]);
  expect(namedAlternatives('Pebble hand wash 250 ml or something else', products)).toEqual([]);
  const result = await prepare({ lines: [{ query: 'Pebble hand wash 250 ml oppure Linen candle 200 g', quantity: 1 }] }, tiered([]));
  expect(!result.ready && result.issues[0]?.candidates).toEqual([{ id: 101, label: 'Pebble hand wash 250 ml' }, { id: 103, label: 'Linen candle 200 g' }]);
});

describe('previous orders', () => {
  const earlier = (number: string, date: string, lines: Partial<ClientOrder['lines'][number]>[]): ClientOrder =>
    ({ id: Number(number), number, date, lines: lines.map(l => ({ code: '', name: '', quantity: 1, netPrice: 0, discountPercent: 0, ...l })) });
  it('compares unit prices after discount with the latest paid line, skipping free ones', async () => {
    const order = await prepared(); // Pebble at €12 with 10% off, delivery at €8 with no discount.
    const found = priceDiscrepancies(order, [
      earlier('9', '2026-01-10', [{ productId: 101, netPrice: 0 }, { productId: 900, netPrice: 8 }]),
      earlier('8', '2025-12-01', [{ productId: 101, netPrice: 12, discountPercent: 20 }]),
      earlier('7', '2025-11-01', [{ productId: 101, netPrice: 30 }]),
    ]);
    expect(found).toEqual([{ name: 'Pebble hand wash 250 ml', now: 10.8, before: 9.6, order: { number: '8', date: '2025-12-01' } }]);
  });
  it('shows price differences from earlier orders in the summary without blocking it', async () => {
    const order = await prepared();
    const text = orderPreview(order, { net: 1, vat: 1, gross: 2 }, true, [{ name: 'Delivery', now: 15, before: 12, order: { number: '77', date: '2026-01-10' } }]);
    expect(text).toContain('⚠️ Da verificare\n• Delivery: ora €15,00, ordine precedente €12,00 (#77, 10/01/2026)');
    expect(text).toContain('💶 Totali');
  });
  it('reads a client\'s orders from Fatture in Cloud with a filter, never other clients\' orders', async () => {
    const listIssuedDocuments = vi.fn().mockResolvedValue({ data: { data: [
      { id: 5, type: 'order', number: 77, date: '2026-01-10', entity: { id: 42 }, items_list: [{ product_id: 7, code: 'DEMO-R', name: 'Linen refill 1 l', qty: 1, net_price: 80, discount: 0 }] },
      { id: 6, type: 'order', number: 136, date: '2026-10-02', entity: { id: 43 }, items_list: [] },
    ] } });
    const connector = new FattureInCloudConnector(1, { documents: { listIssuedDocuments } } as unknown as SdkPorts);
    expect(await connector.listClientOrders(42, 3)).toEqual([{ id: 5, number: '77', date: '2026-01-10', lines: [{ productId: 7, code: 'DEMO-R', name: 'Linen refill 1 l', quantity: 1, netPrice: 80, discountPercent: 0 }] }]);
    expect(listIssuedDocuments).toHaveBeenCalledWith(1, 'order', undefined, 'detailed', '-date', 1, 5, 'entity.id = 42');
  });
});
