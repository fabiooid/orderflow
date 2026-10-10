import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { draftSchema, preparedOrderSchema } from '../src/domain/types.js';
import { DemoConnector } from '../src/connector/demo.js';
import { prepareOrder } from '../src/domain/prepare.js';
import { matchProducts, searchCatalogue } from '../src/domain/matching.js';
import { calculateLineTotals } from '../src/domain/totals.js';
import { config, draft, prepared } from './helpers.js';

describe('business configuration', () => {
  it('rejects unsupported modes and undeclared capabilities', () => {
    expect(() => configSchema.parse({ ...config(), priceBasis: 'gross' })).toThrow();
    expect(() => configSchema.parse({ ...config(), allowInvoices: true })).toThrow();
    expect(() => preparedOrderSchema.parse({ type: 'invoice' })).toThrow();
    expect(() => draftSchema.parse({ ...draft(), vatRate: 0 })).toThrow();
  });
  it('requires precedence for overlapping VAT rules', () => {
    const c = config();
    c.vatRules.push({ ...c.vatRules[0]!, id: 'overlap' });
    expect(() => configSchema.parse(c)).toThrow(/Overlapping/);
    c.vatRules[1]!.priority = 20;
    expect(configSchema.parse(c).vatRules).toHaveLength(2);
  });
  it('rejects conflicting existing/new client selection', () => {
    expect(() => draftSchema.parse({ ...draft(), clientId: 10, newClient: new DemoConnector().clients[0] })).toThrow();
  });
});

describe('product matching', () => {
  const products = [
    { id: 1, code: 'FAKE024', name: 'Foglia di Menta Candela Profumata', description: '', netPrice: 30 },
    { id: 2, code: 'FAKE013', name: 'Lunara Sapone Mani 250ml', description: '', netPrice: 10 },
  ];
  it('matches Italian singular and plural forms', () => {
    expect(matchProducts('Candele Menta', products).map(p => p.id)).toEqual([1]);
    expect(matchProducts('saponi lunara', products).map(p => p.id)).toEqual([2]);
    expect(matchProducts('Candele Lunara', products)).toEqual([]);
    const catalogue = [
      ...products,
      { id: 4, code: 'VP', name: 'Vaporizzatore Mossel', description: '', netPrice: 18 },
      { id: 5, code: 'SP100', name: 'Sapone Mani Mossel 100ml', description: '', netPrice: 8 },
      { id: 6, code: 'SP250', name: 'Sapone Mani Mossel 250ml', description: '', netPrice: 12 },
    ];
    expect(matchProducts('sapone mossel', catalogue).map(p => p.id)).toEqual([5, 6]);
    expect(matchProducts('sapone mossel 250ml', catalogue).map(p => p.id)).toEqual([6]);
  });
  it('gives the agent related products, best first, for a loose description', () => {
    const catalogue = [
      { id: 1, code: 'MENTA', name: 'Foglia di Menta Vaporizzatore 250ml', description: '', netPrice: 17 },
      { id: 2, code: 'FC', name: 'Foglia di Menta Candela Profumata', description: '', netPrice: 30 },
      { id: 3, code: 'CS', name: 'Lunara Sapone Mani 250ml', description: '', netPrice: 10 },
    ];
    expect(searchCatalogue('spray menta', catalogue).map(p => p.id)).toEqual([1, 2]);
    expect(searchCatalogue('candela menta', catalogue)[0]!.id).toBe(2);
    expect(searchCatalogue('gelsomino', catalogue)).toEqual([]);
  });
  it('keeps testers out unless asked', () => {
    const withTester = [...products, { id: 3, code: 'FAKE013T', name: 'TESTER Lunara Sapone Mani 250ml', description: '', netPrice: 5 }];
    expect(matchProducts('Sapone Mani Lunara', withTester).map(p => p.id)).toEqual([2]);
    expect(matchProducts('tester sapone lunara', withTester).map(p => p.id)).toEqual([3]);
  });
});

describe('order preparation', () => {
  it('offers no client candidates when no client was named', async () => {
    const connector = new DemoConnector();
    connector.clients.push({ ...connector.clients[0]!, id: 202, name: 'No VAT Shop', vatNumber: undefined });
    const result = await prepareOrder({ ...draft(), clientQuery: '' }, config(), connector, '2026-01-15');
    if (result.ready) throw new Error('Expected a client question');
    expect(result.issues.find(i => i.field === 'client')?.candidates).toEqual([]);
  });
  it('uses a stated product price and otherwise keeps the catalogue price', async () => {
    const stated = await prepareOrder({ ...draft(), lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2, netPrice: 90 }] }, config(), new DemoConnector(), '2026-01-15');
    expect(stated.ready && stated.order.lines.map(l => l.netPrice)).toEqual([90, 8]);
    const catalogue = await prepared();
    expect(catalogue.lines[0]!.netPrice).toBe(12);
  });
  it('uses catalogue prices and excludes delivery from a percentage discount', async () => {
    const order = await prepared();
    expect(order.lines.map(l => [l.productId, l.netPrice, l.discountPercent])).toEqual([[101, 12, 10], [900, 8, 0]]);
    expect(calculateLineTotals(order.lines)).toEqual({ net: 29.6, vat: 6.51, gross: 36.11 });
    expect(order.delivery.country).toBe('IT');
  });
  it('can explicitly include delivery in a discount', async () => {
    const result = await prepareOrder({ ...draft(), discountShipping: true }, config(), new DemoConnector(), '2026-01-15');
    expect(result.ready && result.order.lines[1]!.discountPercent).toBe(10);
  });
  it('asks when the type is missing instead of using the only related product', async () => {
    const connector = new DemoConnector();
    connector.products[0] = { id: 101, code: 'LUNARA', name: 'Lunara Sapone Mani 250ml', description: '', netPrice: 10 };
    const result = await prepareOrder({ ...draft(), lines: [{ query: 'candele lunara', quantity: 1 }] }, config(), connector, '2026-01-15');
    expect(result.ready).toBe(false);
    if (!result.ready) expect(result.issues.find(i => i.field === 'lines.0')?.candidates?.map(c => c.id)).toEqual([101]);
  });
  it('accepts the agent’s product pick for a loose description, but not an unasked tester', async () => {
    const connector = new DemoConnector();
    const picked = await prepareOrder({ ...draft(), lines: [{ query: 'pebble soap', productId: 101, quantity: 2 }] }, config(), connector, '2026-01-15');
    expect(picked.ready && picked.order.lines[0]!.productId).toBe(101);
    connector.products.push({ id: 104, code: 'T-A', name: 'TESTER Pebble hand wash 250 ml', description: '', netPrice: 0 });
    const tester = await prepareOrder({ ...draft(), lines: [{ query: 'pebble soap', productId: 104, quantity: 1 }] }, config(), connector, '2026-01-15');
    expect(tester.ready).toBe(false);
  });
  it('asks about variants instead of choosing the cheapest candidate', async () => {
    const result = await prepareOrder({ ...draft(), lines: [{ query: 'Pebble 250', quantity: 2 }] }, config(), new DemoConnector(), '2026-01-15');
    expect(result.ready).toBe(false);
    if (!result.ready) expect(result.issues[0]!.candidates?.map(c => c.id)).toEqual([101, 102]);
  });
  it('asks to confirm the delivery amount rather than silently using the default', async () => {
    const result = await prepareOrder({ ...draft(), shippingPrice: undefined }, config(), new DemoConnector(), '2026-01-15');
    expect(!result.ready && result.issues.some(i => i.field === 'shippingPrice')).toBe(true);
  });
  it('omits the delivery line when delivery is removed', async () => {
    const result = await prepareOrder({ ...draft(), shippingPrice: 0 }, config(), new DemoConnector(), '2026-01-15');
    expect(result.ready && result.order.lines.map(l => l.productId)).toEqual([101]);
  });
  it('asks about delivery only after the rest of the order is settled', async () => {
    const result = await prepareOrder({ ...draft(), lines: [{ query: 'Pebble 250', quantity: 2 }], shippingPrice: undefined }, config(), new DemoConnector(), '2026-01-15');
    expect(!result.ready && result.issues.map(i => i.field)).not.toContain('shippingPrice');
  });
  it('does not merge variants even if source codes are equal', async () => {
    const connector = new DemoConnector();
    connector.products[1]!.code = connector.products[0]!.code;
    const result = await prepareOrder({ ...draft(), lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }, { query: 'Pebble hand wash 250 ml sample', quantity: 1 }] }, config(), connector, '2026-01-15');
    expect(result.ready && result.order.lines.map(l => l.productId)).toEqual([101, 102, 900]);
  });
  it('does not accept unknown product IDs or double-count delivery', async () => {
    for (const productId of [999, 900]) {
      const result = await prepareOrder({ ...draft(), lines: [{ query: 'item', productId, quantity: 1 }] }, config(), new DemoConnector(), '2026-01-15');
      expect(result.ready).toBe(false);
    }
  });
  it('writes the delivery address into notes only when one was given', async () => {
    const given = await prepareOrder({ ...draft(), delivery: { country: 'IT', address: 'Via Magazzino 2, Milano' } }, config(), new DemoConnector(), '2026-01-15');
    expect(given.ready && given.order.notes).toMatch(/Via Magazzino 2, Milano$/);
    expect((await prepared()).notes).toBe('');
  });
  it('does not apply an unconfigured destination tax treatment', async () => {
    const result = await prepareOrder({ ...draft(), delivery: { country: 'DE', address: 'Example destination' } }, config(), new DemoConnector(), '2026-01-15');
    expect(!result.ready && result.issues.some(i => i.field === 'vat')).toBe(true);
  });
  it.each(['invalid', 'unavailable', 'unchecked'] as const)('keeps VAT validation %s distinct and blocks preparation', async status => {
    const c = config(); c.vatRules[0]!.requireValidVat = true;
    const result = await prepareOrder(draft(), c, new DemoConnector(), '2026-01-15', async () => status);
    expect(!result.ready && result.issues.some(i => i.message.includes(status))).toBe(true);
  });
  it('flags duplicate new clients using name or tax identity', async () => {
    const connector = new DemoConnector();
    const { id: _, ...newClient } = connector.clients[0]!;
    const result = await prepareOrder({ ...draft(), newClient }, config(), connector, '2026-01-15');
    expect(!result.ready && result.issues[0]!.message).toMatch(/existing client/);
  });
  it('uses the second fictional business configuration without code changes', async () => {
    const c = config(); c.deploymentId = 'second-demo'; c.locale = 'en'; c.shipping.productId = 999;
    c.shipping.discountByDefault = true; c.payments.dueDays = 30;
    c.vatRules = [{ id: 'fictional-example', priority: 1, deliveryCountries: ['FR'], vatId: 8, rate: 10, requireValidVat: false }];
    const connector = new DemoConnector();
    connector.products[0]!.name = 'Notebook A5'; connector.products[0]!.code = 'BOOK';
    connector.products[3]!.id = 999; connector.products[3]!.code = 'FREIGHT';
    const result = await prepareOrder({ ...draft(), lines: [{ query: 'Notebook A5', quantity: 3 }], delivery: { country: 'FR', address: 'Fictional destination' } }, configSchema.parse(c), connector, '2026-01-15');
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.order.lines[1]!.productId).toBe(999);
      expect(result.order.lines[1]!.discountPercent).toBe(10);
      expect(result.order.lines[0]!.vatRate).toBe(10);
      expect(result.order.dueDate).toBe('2026-02-14');
    }
  });
});

it('asks for missing facts in an incomplete order without inventing quantities or client data', async () => {
  const connector = new DemoConnector();
  const empty = await prepareOrder(draftSchema.parse({}), config(), connector, '2026-01-15');
  expect(!empty.ready && empty.issues.map(i => i.field)).toEqual(expect.arrayContaining(['client', 'lines']));
  expect(!empty.ready && empty.issues.map(i => i.field)).not.toContain('shippingPrice');
  const partial = await prepareOrder(draftSchema.parse({ newClient: { name: 'New Example' }, lines: [{ query: 'Linen candle' }] }), config(), connector, '2026-01-15');
  expect(!partial.ready && partial.issues.map(i => i.field)).toContain('lines.0.quantity');
  expect(connector.createCalls).toBe(0);
});

it('asks for the delivery country when the delivery address has none, without a misleading VAT question', async () => {
  const result = await prepareOrder({ ...draft(), delivery: { address: 'Example Road 9, 00000 Example City' } }, config(), new DemoConnector(), '2026-10-09');
  expect(result.ready).toBe(false);
  if (result.ready) return;
  expect(result.issues.map(i => i.field)).toContain('delivery.country');
  expect(result.issues.map(i => i.field)).not.toContain('vat');
});
