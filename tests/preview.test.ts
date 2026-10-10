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
    email: 'ordini@esempio.it', phone: '3330000000', vatNumber: 'IT00000000000', taxCode: 'RSSMRA80A01F205X', sdiCode: 'ABCDEFG', notes: 'Consegna: Via Magazzino 2',
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
    { field: 'client', matchingStatus: 'ambiguous' as const, message: 'Clarify', candidates: [{ id: 1, label: 'Northwind Bistro — Bergamo' }] },
    { field: 'lines.0.quantity', message: 'Specify the quantity' },
    { field: 'lines.1', message: 'Choose the exact product', candidates: [{ id: 2, label: 'Spray Menta 100ml' }] },
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

it('shows the chosen customer on a draft order', () => {
  const draft = draftSchema.parse({ clientQuery: 'Example Studio', clientId: 201, lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }], shippingPrice: 0 });
  const text = orderDraft(draft, [{ field: 'vat', message: 'Check VAT' }], true, { id: 201, name: 'Example Studio', country: 'IT', street: 'Example Street 1', city: 'Example City', postalCode: '00000', notes: '' });
  expect(text).toMatch(/🏪 Example Studio\n📍 Example Street 1, 00000 Example City, IT/);
  expect(text).toContain('🚚 Consegna: nessuna');
  expect(text).toContain('❓ Da completare: controllo IVA');
});
