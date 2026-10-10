import Decimal from 'decimal.js';
import type { OrderLine, Totals } from './types.js';

/** Predictive totals for fixtures/review; the invoicing connector is authoritative for live rounding. */
export function calculateLineTotals(lines: OrderLine[]): Totals {
  let net = new Decimal(0);
  let vat = new Decimal(0);
  for (const line of lines) {
    const amount = new Decimal(line.netPrice).mul(line.quantity).mul(new Decimal(1).minus(new Decimal(line.discountPercent).div(100))).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    net = net.plus(amount);
    vat = vat.plus(amount.mul(line.vatRate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
  }
  return { net: net.toNumber(), vat: vat.toNumber(), gross: net.plus(vat).toNumber() };
}
