import type { ClientOrder, PreparedOrder } from './types.js';

/** A charged unit that is not explained by the current catalogue. Shown under Da verificare; never applied. */
export type Discrepancy = { name: string; now: number; before: number; order: { number: string; date: string } };
/** Lines that use the current catalogue after last paid was lower. Shown once, not as per-SKU warnings. */
export type CatalogueIncrease = { count: number; orders: { number: string; date: string }[] };
export type PriceHistory = { anomalies: Discrepancy[]; catalogueIncreases: CatalogueIncrease };

const unit = (netPrice: number, discountPercent: number) => Math.round(netPrice * (100 - discountPercent)) / 100;

function listPrice(line: { productId: string }, catalogue: ReadonlyMap<string, number>) {
  return catalogue.get(line.productId);
}

/** Current line is the live catalogue price, same discount as last time, and last paid net was lower. */
function followsCatalogueIncrease(
  line: { productId: string; netPrice: number; discountPercent: number },
  match: { netPrice: number; discountPercent: number },
  catalogue: ReadonlyMap<string, number>,
) {
  const list = listPrice(line, catalogue);
  return list !== undefined && line.netPrice === list && match.discountPercent === line.discountPercent && match.netPrice < line.netPrice;
}

/**
 * Compare each line, shipping included, with the most recent earlier order that charged for the same product.
 * Free history lines were one-off gifts and are skipped. A general catalogue increase is grouped; overrides
 * and other history units stay as anomalies.
 */
export function priceDiscrepancies(
  order: PreparedOrder,
  previous: ClientOrder[],
  catalogue: Iterable<{ id: string; netPrice: number }> = [],
): PriceHistory {
  const prices = new Map([...catalogue].map(product => [product.id, product.netPrice]));
  const anomalies: Discrepancy[] = [];
  const increaseOrders: CatalogueIncrease['orders'] = [];
  let increaseCount = 0;
  for (const line of order.lines) {
    for (const earlier of previous) {
      const match = earlier.lines.find(l => (l.productId === line.productId || (line.code !== '' && l.code === line.code)) && l.netPrice > 0);
      if (!match) continue;
      const now = unit(line.netPrice, line.discountPercent), before = unit(match.netPrice, match.discountPercent);
      if (now !== before) {
        const ref = { number: earlier.number, date: earlier.date };
        if (followsCatalogueIncrease(line, match, prices)) {
          increaseCount += 1;
          increaseOrders.push(ref);
        } else {
          anomalies.push({ name: line.name, now, before, order: ref });
        }
      }
      break;
    }
  }
  return { anomalies, catalogueIncreases: { count: increaseCount, orders: increaseOrders } };
}
