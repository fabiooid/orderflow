import { expect, it } from 'vitest';
import { askedText, customerPreview, orderPreview } from '../src/telegram/preview.js';
import { draftSchema } from '../src/domain/types.js';
import { prepared } from './helpers.js';

it('shows one billing address and adds no notes that were not asked for', async () => {
  const order = await prepared();
  const text = orderPreview(order, { net: 29.6, vat: 6.51, gross: 36.11 }, true, true);
  expect(text).toContain('📦 Anteprima ordine');
  expect(text).toContain('🏪 Example Studio');
  expect(text).toContain('📍 Example Street 1, 00000 Example City, IT');
  expect(text).not.toContain('Fatturazione');
  expect(order.notes).toBe('');
  expect(text).not.toContain('📝 Note');
  expect(text).toContain('1 × Delivery — €8,00');
  expect(text).toContain('/confermaordine');
  expect(text).not.toContain('u1');
  order.lines.forEach(line => { line.discountPercent = 0; });
  const withoutDiscount = orderPreview(order, { net: 29.6, vat: 6.51, gross: 36.11 }, true, true);
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
  expect(text).not.toContain('CLIENTE —');
});

it('keeps each product question with its own choices', () => {
  const text = askedText([
    { field: 'lines.1', message: 'No exact product', candidates: [{ id: 1, label: 'Foglia di Menta Vaporizzatore 250ml' }] },
    { field: 'lines.3', message: 'No exact product', candidates: [{ id: 2, label: 'Rosmarino Sapone Esfoliante Mani 500ml' }] },
  ], draftSchema.parse({ lines: [{ query: 'sapone lavanda 250ml' }, { query: 'spray menta' }, { query: 'candele gelsomino' }, { query: 'sapone rosmarino' }] }), true);
  expect(text).toBe('Per spray menta, quale prodotto scegli?\nFoglia di Menta Vaporizzatore 250ml\n\nPer sapone rosmarino, quale prodotto scegli?\nRosmarino Sapone Esfoliante Mani 500ml');
  expect(text).not.toContain('sapone lavanda');
});

it('says when nothing matched instead of offering an empty choice', () => {
  const text = askedText([{ field: 'lines.0', message: 'No matching product', candidates: [] }], draftSchema.parse({ lines: [{ query: 'sapone gelsomino' }] }), true);
  expect(text).toBe('Non trovo un prodotto per sapone gelsomino.');
});
