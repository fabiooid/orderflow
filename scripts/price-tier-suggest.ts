import { parseArgs } from 'node:util';
import { Configuration, IssuedDocumentsApi } from '@fattureincloud/fattureincloud-ts-sdk';
import { loadAppConfig } from '../src/config/load.js';
import { tierPrices } from '../src/config/schema.js';
import { FattureInCloudConnector } from '../src/connector/fatture-in-cloud.js';

/**
 * Suggests which clients belong to a price tier: those whose recent orders were mostly charged the tier's prices
 * where these differ from the catalogue. Read-only; the list is printed for review, never written to config.
 */
async function main() {
  const { values } = parseArgs({ options: { tier: { type: 'string' }, orders: { type: 'string', default: '300' } } });
  if (!values.tier) { console.error('Usage: npm run pricetier:suggest -- --tier <price-tier-id> [--orders 300]'); process.exit(1); }
  const config = await loadAppConfig();
  const prices = tierPrices(config, values.tier);
  if (!prices.size) { console.error(`No order form gives prices for tier "${values.tier}". Import one with --tier ${values.tier} and list it in orderForms.`); process.exit(1); }
  const token = process.env.FIC_ACCESS_TOKEN ?? '';
  const connector = FattureInCloudConnector.fromToken(config.companyId, token);
  const catalogue = new Map((await connector.listProducts()).map(p => [p.id, p.netPrice]));
  const api = new IssuedDocumentsApi(new Configuration({ accessToken: token, baseOptions: { timeout: 20000 } }));
  
  const wanted = Number(values.orders);
  const score = new Map<number, { name: string; tier: number; standard: number; orders: number }>();
  for (let page = 1, seen = 0; seen < wanted; page++) {
    const { data } = await api.listIssuedDocuments(config.companyId, 'order', undefined, 'detailed', '-date', page, 100);
    for (const order of data.data ?? []) {
      const id = order.entity?.id;
      if (!id || seen++ >= wanted) continue;
      const entry = score.get(id) ?? { name: order.entity?.name ?? '?', tier: 0, standard: 0, orders: 0 };
      entry.orders++;
      for (const item of order.items_list ?? []) {
        const tier = item.product_id ? prices.get(item.product_id) : undefined, standard = item.product_id ? catalogue.get(item.product_id) : undefined;
        // Only products whose tier price differs from the catalogue say anything about the client.
        if (tier === undefined || standard === undefined || tier === standard) continue;
        if (item.net_price === tier) entry.tier++;
        else if (item.net_price === standard) entry.standard++;
      }
      score.set(id, entry);
    }
    if (!data.next_page_url) break;
  }
  const suggested = [...score.entries()].filter(([, s]) => s.tier >= 2 && s.tier > s.standard).sort((a, b) => b[1].tier - a[1].tier);
  console.log(`Clients charged "${values.tier}" prices in the last ${wanted} orders (lines at tier price / at catalogue price):\n`);
  for (const [id, s] of suggested) console.log(`  ${id}\t${s.tier}/${s.standard}\t${s.orders} orders\t${s.name}`);
  console.log(`\nReview this list, then add the IDs you agree with to priceTiers → "${values.tier}" → clientIds:\n  [${suggested.map(([id]) => id).join(', ')}]`);
}

main().catch(error => {
  // SDK and model errors can carry authorization headers; never print them.
  console.error(`Suggestion failed: ${error instanceof Error && !('config' in error) ? error.message : 'check APP_CONFIG_PATH, credentials and connectivity'}`);
  process.exitCode = 1;
});
