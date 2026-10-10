import { isDeepStrictEqual } from 'node:util';
import { draftSchema, type OrderDraft } from '../domain/types.js';
import type { Conversation } from '../telegram/store.js';
import { expect, type ConversationCase } from './harness.js';

type Line = { productId: number; quantity: number; netPrice: number; discountPercent: number; vatId: number };
/** What the operator ends up with: the prepared order, or the fields still asked about. */
export type Outcome = { ready: false; issues: string[] } | { ready: true; clientId?: number; lines: Line[]; deliveryCountry: string; totals: { net: number; vat: number; gross: number } };

const merchandise = (quantity = 2, netPrice = 12, discountPercent = 0): Line => ({ productId: 101, quantity, netPrice, discountPercent, vatId: 1 });
const shipping: Line = { productId: 900, quantity: 1, netPrice: 8, discountPercent: 0, vatId: 1 };
const base = draftSchema.parse({ clientQuery: 'Example Studio', lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }], shippingPrice: 8 });
const ready = (lines: Line[], net: number, vat: number, gross: number): Outcome => ({ ready: true, clientId: 201, lines, deliveryCountry: 'IT', totals: { net, vat, gross } });

/** The outcome the operator sees after the last message. */
export function observedOutcome(request?: Conversation): Outcome {
  if (request?.status !== 'ready' || !request.prepared || !request.totals) return { ready: false, issues: (request?.issues ?? []).map(i => i.field).sort() };
  const order = request.prepared;
  return { ready: true, clientId: order.client.id, lines: order.lines.map(({ productId, quantity, netPrice, discountPercent, vatId }) => ({ productId, quantity, netPrice, discountPercent, vatId })), deliveryCountry: order.delivery.country, totals: request.totals };
}
/** Exact customer, lines, prices, discounts, VAT, delivery and totals, or exactly the fields still asked about. */
export const exactOutcome = (expected: Outcome): ConversationCase['check'] => o => {
  const observed = observedOutcome(o.open);
  return expect(isDeepStrictEqual(observed, expected), `expected ${JSON.stringify(expected)}; observed ${JSON.stringify(observed)}`);
};

/** Fictional order scenarios with exact expected outcomes, which are never shown to the model. */
const scenarios: [id: string, messages: string[], scripted: OrderDraft[], expected: Outcome][] = [
  ['italian-order', ['Prepara un ordine per Example Studio: 2 Pebble hand wash 250 ml. Spedizione 8 euro.'], [base], ready([merchandise(), shipping], 32, 7.04, 39.04)],
  ['english-order', ['Prepare an order for Example Studio: two Pebble hand wash 250 ml, delivery 8 euros.'], [base], ready([merchandise(), shipping], 32, 7.04, 39.04)],
  ['quantity-correction', ['Prepara un ordine per Example Studio: 2 Pebble hand wash 250 ml, spedizione 8 euro.', 'No, ho detto 5 pezzi, non 2. Il resto è corretto.'], [base, { ...base, lines: [{ query: 'Pebble hand wash 250 ml', quantity: 5 }] }], ready([merchandise(5), shipping], 68, 14.96, 82.96)],
  ['custom-price', ['Order for Example Studio: 2 Pebble hand wash 250 ml at a custom net unit price of 9 euros, 10% discount on products only, delivery 8 euros.'], [{ ...base, lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2, netPrice: 9 }], discountPercent: 10 }], ready([merchandise(2, 9, 10), shipping], 24.2, 5.32, 29.52)],
  ['discount-excludes-delivery', ['Ordine per Example Studio: 2 Pebble hand wash 250 ml, sconto 10%, spedizione 8 euro.'], [{ ...base, discountPercent: 10 }], ready([merchandise(2, 12, 10), shipping], 29.6, 6.51, 36.11)],
  ['missing-delivery', ['Prepare an order for Example Studio: 2 Pebble hand wash 250 ml.'], [{ ...base, shippingPrice: undefined }], { ready: false, issues: ['shippingPrice'] }],
];
export const acceptanceCases: ConversationCase[] = scenarios.map(([id, messages, scripted, expected]) => ({ id, turns: messages.map(text => ({ text })), scripted, check: exactOutcome(expected) }));
