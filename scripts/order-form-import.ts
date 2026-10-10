import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { connectorMode, loadAppConfig } from '../src/config/load.js';
import { orderFormSchema, type OrderForm } from '../src/config/schema.js';
import { DemoConnector } from '../src/connector/demo.js';
import { FattureInCloudConnector } from '../src/connector/fatture-in-cloud.js';
import { normalize } from '../src/domain/matching.js';
import type { Product } from '../src/domain/types.js';

/**
 * Builds an order-form template from a clean (unfilled) PDF of a printed price list: its rows, the columns customers
 * write in, and the product each cell orders (by printed code, then by the model using the printed notes).
 * Read-only; review the output before use.
 */
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { id: { type: 'string' }, tier: { type: 'string' }, out: { type: 'string' } } });
  const file = positionals[0];
  if (!file || !values.id) {
    console.error('Usage: npm run orderform:import -- <price-list.pdf> --id <form-id> [--tier <price-tier-id>] [--out <file.json>]');
    process.exit(1);
  }
  const out = values.out ?? `private/order-forms/${values.id}.json`;
  const config = await loadAppConfig();
  const connector = connectorMode() === 'demo' ? new DemoConnector() : FattureInCloudConnector.fromToken(config.invoicing.companyId, process.env.FIC_ACCESS_TOKEN ?? '');
  const catalogue = await connector.listProducts();
  const agent = new Agent({ id: 'order-form-import', name: 'Order form import', model: config.model, instructions: 'You transcribe printed price lists exactly and map them to a product catalogue. Never invent rows or products.' });
  
  const sheet = (await agent.generate([{ role: 'user', content: [
    { type: 'text', text: `Transcribe this printed price list / order form. List every product row on every page, in printed order. Section titles are not rows.
  - headings: the printed column headings of the table.
  - columns: the columns a customer writes in (fill-in columns). id: a short lowercase slug; heading: as printed; value: "quantity" for a number of pieces, "mark" for an X or tick.
  - code: the product code printed on the row (such as an SKU), or "" if none. Not the barcode.
  - label: the product description as printed.
  - netPrice: the price for the reseller excluding VAT (not a suggested retail price including VAT), or null.
  - notes: printed text that applies to this row's fill-in cells, including notes printed in a section heading above the row, with the column id.` },
    { type: 'file', data: await readFile(file), mediaType: 'application/pdf', filename: 'form.pdf' },
  ] }], { structuredOutput: { schema: z.object({
    name: z.string(), headings: z.array(z.string()),
    columns: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]+$/), heading: z.string(), value: z.enum(['quantity', 'mark']) })),
    rows: z.array(z.object({ code: z.string(), label: z.string(), netPrice: z.number().nullable(), notes: z.array(z.object({ column: z.string(), text: z.string() })) })),
  }) } })).object;
  const main = sheet.columns.find(c => c.value === 'quantity') ?? sheet.columns[0];
  if (!main) throw new Error('No fill-in column found on the form');
  
  // A printed code that matches a catalogue code settles the main column; the model maps every other cell.
  const byCode = new Map(catalogue.filter(p => p.code).map(p => [normalize(p.code), p]));
  const cells = new Map<string, Product>();
  sheet.rows.forEach((row, i) => { const p = row.code && byCode.get(normalize(row.code)); if (p) cells.set(`${i}:${main.id}`, p); });
  const mapping = (await agent.generate(`For every row and fill-in column of this order form, which catalogue product does writing in that cell order? Use the column heading and the printed notes. Answer null when the cell orders nothing (for example a note says none is available) or no product fits exactly.
  Columns:\n${sheet.columns.map(c => `- ${c.id}: "${c.heading}" (${c.value})`).join('\n')}
  Rows:\n${sheet.rows.map((r, i) => `${i + 1}. ${r.code || '(no code)'} — ${r.label}${r.notes.length ? ` — notes: ${r.notes.map(n => `[${n.column}] ${n.text}`).join('; ')}` : ''}${cells.has(`${i}:${main.id}`) ? ` — ${main.id} is ${cells.get(`${i}:${main.id}`)!.code}` : ''}`).join('\n')}
  Catalogue:\n${catalogue.map(p => `${p.id}: ${p.code} — ${p.name}`).join('\n')}`,
    { structuredOutput: { schema: z.object({ cells: z.array(z.object({ row: z.number().int(), column: z.string(), productId: z.number().int().nullable() })) }) } })).object;
  for (const c of mapping.cells) {
    const p = catalogue.find(p => p.id === c.productId);
    if (p && !cells.has(`${c.row - 1}:${c.column}`) && sheet.columns.some(col => col.id === c.column)) cells.set(`${c.row - 1}:${c.column}`, p);
  }
  
  const rows: OrderForm['rows'] = [];
  console.log(`\n${sheet.name} — ${sheet.rows.length} rows; fill-in columns: ${sheet.columns.map(c => `${c.id} (${c.value})`).join(', ')}\n`);
  sheet.rows.forEach((row, i) => {
    const price = row.netPrice ?? undefined;
    const mapped = Object.fromEntries(sheet.columns.flatMap(c => {
      const p = cells.get(`${i}:${c.id}`);
      return p ? [[c.id, { productId: p.id, ...(c.id === main.id && price !== undefined ? { netPrice: price } : {}) }]] : [];
    }));
    const own = cells.get(`${i}:${main.id}`);
    const flags = [!own ? `${main.id} NOT MAPPED: fix by hand` : '', own && row.code && normalize(row.code) !== normalize(own.code) ? `code differs (${own.code})` : '', own && price !== undefined && !values.tier && price !== own.netPrice ? `catalogue price ${own.netPrice}` : ''].filter(Boolean);
    const shown = sheet.columns.map(c => `${c.id}: ${cells.get(`${i}:${c.id}`)?.code ?? '—'}`).join(' · ');
    console.log(`${String(i + 1).padStart(3)}. ${(row.code || '—').padEnd(6)} ${row.label.slice(0, 50).padEnd(50)} → ${shown}${price !== undefined ? ` · €${price}` : ''}${flags.length ? `   ⚠️ ${flags.join('; ')}` : ''}`);
    if (Object.keys(mapped).length) rows.push({ code: row.code, label: row.label, cells: mapped });
  });
  
  const form = orderFormSchema.parse({ schemaVersion: 1, id: values.id, name: sheet.name, ...(values.tier ? { priceTier: values.tier } : {}), headings: sheet.headings, columns: sheet.columns.map(({ id, heading, value }) => ({ id, heading, value })), rows });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(form, null, 2)}\n`);
  console.log(`\nWrote ${out}. Review it, then list it in your business config:\n  "orderForms": ["${out}"]${values.tier ? `\n  "priceTiers": [{ "id": "${values.tier}", "name": "…", "clientIds": [] }]` : ''}\nKeep it out of git: it describes your business.`);
}

main().catch(error => {
  // SDK and model errors can carry authorization headers; never print them.
  console.error(`Import failed: ${error instanceof Error && !('config' in error) ? error.message : 'check APP_CONFIG_PATH, credentials and connectivity'}`);
  process.exitCode = 1;
});
