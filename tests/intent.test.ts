import { expect, it } from 'vitest';
import { clientSearchNamedThisTurn, statedNote, statedShipping } from '../src/assistant/intent.js';
import { testerRestatementOf } from '../src/domain/matching.js';

it('reads no-charge and amount statements from Italian or English wording, and the last statement wins', () => {
  expect(statedShipping('niente consegna')).toBe(0);
  expect(statedShipping('no consegna')).toBe(0);
  expect(statedShipping('nessuna spedizione')).toBe(0);
  expect(statedShipping('no delivery')).toBe(0);
  expect(statedShipping('without shipping')).toBe(0);
  expect(statedShipping('senza consegna')).toBe(0);
  expect(statedShipping('crea ordine per Harbour Shop')).toBeUndefined();
  expect(statedShipping('crea ordine per Harbour Shop\nniente consegna')).toBe(0);
  expect(statedShipping('niente consegna\nspedizione 8 euro')).toBe(8);
  expect(statedShipping('delivery 8 euros\nno charge')).toBe(0);
  expect(statedShipping('niente consegna', 'spedizione 8')).toBe(8);
  expect(statedShipping('spedizione 8 euro', 'niente consegna')).toBe(0);
  expect(statedShipping('')).toBeUndefined();
});

it('reads a labelled note without the role word', () => {
  expect(statedNote('nota: lasciare al banco')).toBe('lasciare al banco');
  expect(statedNote('note: ship in January')).toBe('ship in January');
  expect(statedNote('ordine per Example Studio, spedizione 8 euro, nota: Spedire a gennaio')).toBe('Spedire a gennaio');
  expect(statedNote('change the quantity to 5')).toBeUndefined();
  expect(statedNote('')).toBeUndefined();
});

it('grounds a client search in this message and ignores a previous-chat name', () => {
  expect(clientSearchNamedThisTurn('Northwind', 'Northwind')).toBe(true);
  expect(clientSearchNamedThisTurn('Northwind Bistro', 'Northwind')).toBe(true);
  expect(clientSearchNamedThisTurn('Northwind Bistro', 'cliente Northwind')).toBe(true);
  expect(clientSearchNamedThisTurn('Example Studio', 'Yes, prepare an order from this.')).toBe(false);
  expect(clientSearchNamedThisTurn('Example Studio', 'Prepare an order from this list: 3 Pebble hand wash 250 ml')).toBe(false);
});

it('treats a tester alias as the same source line and keeps sale+tester and distinct quantities apart', () => {
  expect(testerRestatementOf(
    { query: 'PEBBLE-100', quantity: 1, tester: true },
    { query: 'Pebble tester', quantity: 1, tester: true },
  )).toBe(true);
  expect(testerRestatementOf(
    { query: 'DEMO-A Pebble hand wash 250 ml tester', quantity: 1, tester: true },
    { query: 'Pebble tester', quantity: 1 },
  )).toBe(true);
  expect(testerRestatementOf(
    { query: 'DEMO-A', quantity: 1, tester: true },
    { query: 'Pebble tester', quantity: 1, tester: true },
  )).toBe(false);
  expect(testerRestatementOf(
    { query: 'DEMO-A Pebble hand wash 250 ml', quantity: 2 },
    { query: 'DEMO-A Pebble hand wash 250 ml tester', quantity: 1, tester: true },
  )).toBe(false);
  expect(testerRestatementOf(
    { query: 'DEMO-A', quantity: 1, tester: true },
    { query: 'DEMO-A', quantity: 2, tester: true },
  )).toBe(false);
  expect(testerRestatementOf(
    { query: 'Linen candle tester', quantity: 1, tester: true },
    { query: 'Pebble tester', quantity: 1, tester: true },
  )).toBe(false);
});
