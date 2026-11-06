import { expect, it } from 'vitest';
import { customerPreview, orderDraft, orderPreview, pickable } from '../src/channel/preview.js';
import { draftSchema } from '../src/domain/types.js';
import { prepared } from './helpers.js';

it('shows one billing address, no notes nobody asked for, and no slash commands', async () => {
  const order = await prepared();
  const text = orderPreview(order, { net: 29.6, vat: 6.51, gross: 36.11 }, true);
  expect(text).toContain('📦 Anteprima ordine');
  expect(text).toContain('🏪 Example Studio');
  expect(text).toContain('📍 Example Street 1, 00000 Example City, IT');
  expect(text).not.toContain('Fatturazione');
  expect(order.notes).toBe('');
  expect(text).not.toContain('📝 Note');
  expect(text).toContain('1 × Delivery — €8,00');
  expect(text).not.toContain('/');
  expect(text).not.toContain('u1');
  order.lines.forEach(line => { line.discountPercent = 0; });
  const withoutDiscount = orderPreview(order, { net: 29.6, vat: 6.51, gross: 36.11 }, true);
  expect(withoutDiscount).not.toContain('sconto');
  expect(withoutDiscount).not.toContain('0%');
});

it('uses the shop, person and number icons on a new customer', () => {
  const text = customerPreview({
    name: 'Cliente Test', country: 'IT', street: 'Via Esempio 1', city: 'Milano', postalCode: '20100',
    email: 'ordini@example.invalid', phone: '3330000000', vatNumber: 'IT00000000000', taxCode: 'RSSMRA80A01F205X', sdiCode: 'ABCDEFG', notes: 'Consegna: Via Magazzino 2',
  }, true);
  expect(text).toContain('🏪 Cliente Test');
  expect(text).toContain('👤 Codice fiscale RSSMRA80A01F205X');
  expect(text).toContain('🔢 SDI ABCDEFG');
  expect(text).toContain('📝 Note');
  expect(text).not.toContain('/');
});

it('shows a draft customer with what is still missing', () => {
  const text = customerPreview({ name: 'Fable Goods' }, true, ['email', 'vatNumber']);
  expect(text).toContain('👤 Nuovo cliente');
  expect(text).toContain('❓ Da completare: email · partita iva');
  expect(text).not.toContain('Facoltativi');
  expect(customerPreview({}, false, ['name'])).toContain('🏪 ❓');
});

it('shows a draft order with what is known and marks each missing piece', () => {
  const draft = draftSchema.parse({ clientQuery: 'Northwind', lines: [{ query: 'sapone menta' }, { query: 'spray menta', quantity: 2 }, { query: 'candela', quantity: 1, netPrice: 9 }] });
  const issues = [
    { field: 'client', matchingStatus: 'ambiguous' as const, message: 'Clarify', candidates: [{ id: '1', label: 'Northwind Bistro — Bergamo' }] },
    { field: 'lines.0.quantity', message: 'Specify the quantity' },
    { field: 'lines.1', message: 'Choose the exact product', candidates: [{ id: '2', label: 'Spray Menta 100ml' }] },
    { field: 'shippingPrice', message: 'Confirm the delivery charge', defaultPrice: 8 },
  ];
  const text = orderDraft(draft, issues, true);
  expect(text).toContain('📝 Bozza ordine');
  expect(text).toContain('🏪 Northwind ❓');
  expect(text).toContain('❓ × sapone menta');
  expect(text).toContain('2 × spray menta ❓');
  expect(text).toContain('1 × candela — €9,00');
  expect(text).toContain('🚚 Consegna: ❓');
  expect(text).toContain('❓ Da completare: cliente · quantità per sapone menta · prodotto per spray menta · costo di consegna');
  expect(orderDraft(draft, issues, false)).toContain('📝 Draft order');
  // Customer and product candidates become buttons; other questions are for the agent to ask.
  expect(issues.filter(pickable).map(i => i.field)).toEqual(['client', 'lines.1']);
});

it('shows catalogue name and price once a line is matched, and keeps original wording only as context', () => {
  const draft = draftSchema.parse({
    clientQuery: 'Example Studio',
    lines: [
      { query: 'A1 SAP-MNT scanned label', productId: '101', quantity: 2 },
      { query: 'unknown scanned row', quantity: 1 },
      { query: 'Pebble hand wash 250 ml', productId: '101', quantity: 3 },
    ],
  });
  const catalogue = [
    { id: '101', name: 'Pebble hand wash 250 ml', netPrice: 12 },
    { id: '103', name: 'Linen candle 200 g', netPrice: 20 },
  ];
  const issues = [
    { field: 'lines.1', message: 'Choose the exact product' },
    { field: 'shippingPrice', message: 'Confirm the delivery charge' },
  ];
  const text = orderDraft(draft, issues, true, undefined, 'EUR', catalogue);
  expect(text).toContain('2 × Pebble hand wash 250 ml (A1 SAP-MNT scanned label) — €12,00');
  expect(text).toContain('1 × unknown scanned row ❓');
  expect(text).toContain('3 × Pebble hand wash 250 ml — €12,00');
  expect(text).not.toMatch(/^2 × A1 SAP-MNT scanned label/m);
  expect(text).toContain('❓ Da completare: prodotto per unknown scanned row · costo di consegna');
});

it('uses an explicit line price instead of the catalogue price when one is already on the draft', () => {
  const draft = draftSchema.parse({
    clientQuery: 'Example Studio',
    lines: [{ query: 'form code A1', productId: '101', quantity: 2, netPrice: 9 }],
  });
  const text = orderDraft(draft, [], false, undefined, 'EUR', [{ id: '101', name: 'Pebble hand wash 250 ml', netPrice: 12 }]);
  expect(text).toContain('2 × Pebble hand wash 250 ml (form code A1) — €9.00');
  expect(text).not.toContain('12.00');
});

it('shows the chosen customer on a draft order', () => {
  const draft = draftSchema.parse({ clientQuery: 'Example Studio', clientId: '201', lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }], shippingPrice: 0 });
  const text = orderDraft(draft, [{ field: 'vat', message: 'Check VAT' }], true, { id: '201', name: 'Example Studio', country: 'IT', street: 'Example Street 1', city: 'Example City', postalCode: '00000', notes: '' });
  expect(text).toMatch(/🏪 Example Studio\n📍 Example Street 1, 00000 Example City, IT/);
  expect(text).toContain('🚚 Consegna: nessuna');
  expect(text).toContain('❓ Da completare: controllo IVA');
});

it('shows a configured currency other than euro after the amount', async () => {
  const order = await prepared();
  const text = orderPreview(order, { net: 29.6, vat: 6.51, gross: 36.11 }, false, [], 'USD');
  expect(text).toContain('12.00 USD');
  expect(text).not.toContain('€');
});
