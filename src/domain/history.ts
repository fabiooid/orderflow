import type { ClientOrder, PreparedOrder } from './types.js';

/** A price that differs from what the same client paid last time. Shown to the operator; never applied. */
export type Discrepancy = { name: string; now: number; before: number; order: { number: string; date: string } };

const unit = (netPrice: number, discountPercent: number) => Math.round(netPrice * (100 - discountPercent)) / 100;

/** Compares each line, shipping included, with the most recent earlier order that charged for the same product. Free lines were one-off gifts and are skipped. */
export function priceDiscrepancies(order: PreparedOrder, previous: ClientOrder[]): Discrepancy[] {
  const found: Discrepancy[] = [];
  for (const line of order.lines) {
    for (const earlier of previous) {
      const match = earlier.lines.find(l => (l.productId === line.productId || (line.code !== '' && l.code === line.code)) && l.netPrice > 0);
      if (!match) continue;
      const now = unit(line.netPrice, line.discountPercent), before = unit(match.netPrice, match.discountPercent);
      if (now !== before) found.push({ name: line.name, now, before, order: { number: earlier.number, date: earlier.date } });
      break;
    }
  }
  return found;
}
