import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { connectorMode, loadAppConfig } from '../src/config/load.js';
import { orderFormSchema, type OrderForm } from '../src/config/schema.js';
import { DemoConnector } from '../src/connector/demo.js';
import { FattureInCloudConnector } from '../src/connector/fatture-in-cloud.js';
import { isTester, normalize } from '../src/domain/matching.js';
import type { Product } from '../src/domain/types.js';

/**
 * Builds an order-form template from a clean (unfilled) PDF of a printed price list: one row per printed product,
 * mapped to the catalogue by code, then by the model for rows without one. Read-only; review the output before use.
 */
const { values, positionals } = parseArgs({ allowPositionals: true, options: { id: { type: 'string' }, tier: { type: 'string' }, out: { type: 'string' } } });
const file = positionals[0];
if (!file || !values.id) {
  console.error('Usage: npm run orderform:import -- <price-list.pdf> --id <form-id> [--tier <price-tier-id>] [--out <file.json>]');
  process.exit(1);
}
const out = values.out ?? `private/order-forms/${values.id}.json`;
const config = await loadAppConfig();
const connector = connectorMode() === 'demo' ? new DemoConnector() : FattureInCloudConnector.fromToken(config.companyId, process.env.FIC_ACCESS_TOKEN ?? '');
const catalogue = await connector.listProducts();
const agent = new Agent({ id: 'order-form-import', name: 'Order form import', model: config.model, instructions: 'You transcribe printed price lists exactly and map them to a product catalogue. Never invent rows or products.' });

const sheet = (await agent.generate([{ role: 'user', content: [
  { type: 'text', text: `Transcribe this printed price list / order form. List every product row on every page, in printed order. Section titles are not rows.
- code: the product code printed on the row (such as an SKU), or "" if none. Not the barcode.
- label: the product description as printed.
- netPrice: the price for the reseller excluding VAT (not a suggested retail price including VAT), or null.
- headings: the printed column headings of the table.
- testerColumn: true if the table has a column to ask for testers.` },
  { type: 'file', data: await readFile(file), mediaType: 'application/pdf', filename: 'form.pdf' },
] }], { structuredOutput: { schema: z.object({
  name: z.string(), headings: z.array(z.string()), testerColumn: z.boolean(),
  rows: z.array(z.object({ code: z.string(), label: z.string(), netPrice: z.number().nullable() })),
}) } })).object;

const byCode = new Map(catalogue.filter(p => p.code).map(p => [normalize(p.code), p]));
const products = catalogue.filter(p => !isTester(p));
const mapped = new Map<number, Product>();
sheet.rows.forEach((row, i) => { const p = row.code && byCode.get(normalize(row.code)); if (p && !isTester(p)) mapped.set(i, p); });
const missing = sheet.rows.map((row, i) => ({ row: i + 1, ...row })).filter(r => !mapped.has(r.row - 1));
if (missing.length) {
  const guess = (await agent.generate(`Map each printed row to the catalogue product it sells, or null if none fits exactly (same product type, scent and size).
Rows:\n${missing.map(r => `${r.row}. ${r.code || '(no code)'} — ${r.label}`).join('\n')}
Catalogue:\n${products.map(p => `${p.id}: ${p.code} — ${p.name}`).join('\n')}`,
  { structuredOutput: { schema: z.object({ rows: z.array(z.object({ row: z.number().int(), productId: z.number().int().nullable() })) }) } })).object;
  for (const g of guess.rows) { const p = products.find(p => p.id === g.productId); if (p) mapped.set(g.row - 1, p); }
}

// The tester of a product: the tester coded like it plus "T", else the one named like it once sizes and the word "tester" are removed.
const stem = (name: string) => normalize(name).split(' ').filter(w => w !== 'tester' && !/^\d+(ml|lt|l|gr|g)?$/.test(w) && !['ml', 'lt', 'gr'].includes(w)).join(' ');
const testers = catalogue.filter(isTester);
const testerFor = (p: Product) => (testers.find(t => p.code && normalize(t.code) === normalize(`${p.code}T`)) ?? testers.find(t => stem(t.name) === stem(p.name)))?.id;

const rows: OrderForm['rows'] = [];
console.log(`\n${sheet.name} — ${sheet.rows.length} rows\n`);
sheet.rows.forEach((row, i) => {
  const p = mapped.get(i);
  const tester = p && sheet.testerColumn ? testerFor(p) : undefined;
  const price = row.netPrice ?? undefined;
  const flags = [!p ? 'NOT MAPPED: add by hand or skip' : '', p && row.code && normalize(row.code) !== normalize(p.code) ? `code differs (${p.code})` : '', p && price !== undefined && !values.tier && price !== p.netPrice ? `catalogue price ${p.netPrice}` : ''].filter(Boolean);
  console.log(`${String(i + 1).padStart(3)}. ${(row.code || '—').padEnd(6)} ${row.label.slice(0, 60).padEnd(60)} → ${p ? `${p.code} ${p.name}` : '?'}${tester ? ` · tester ${catalogue.find(t => t.id === tester)?.code}` : ''}${price !== undefined ? ` · €${price}` : ''}${flags.length ? `   ⚠️ ${flags.join('; ')}` : ''}`);
  if (p) rows.push({ code: row.code, label: row.label, productId: p.id, ...(tester ? { testerProductId: tester } : {}), ...(price !== undefined ? { netPrice: price } : {}) });
});

const form = orderFormSchema.parse({ schemaVersion: 1, id: values.id, name: sheet.name, ...(values.tier ? { priceTier: values.tier } : {}), headings: sheet.headings, rows });
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(form, null, 2)}\n`);
console.log(`\nWrote ${out}. Review it, then list it in your business config:\n  "orderForms": ["${out}"]${values.tier ? `\n  "priceTiers": [{ "id": "${values.tier}", "name": "…", "clientIds": [] }]` : ''}\nKeep it out of git: it describes your business.`);
