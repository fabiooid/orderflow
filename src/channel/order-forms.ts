import { z } from 'zod';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { OrderForm } from '../config/schema.js';
import { copy } from './locales/index.js';

/**
 * Filled-in order forms are read against their template: the model only says which numbered printed row and which
 * column carry which handwritten value, and the template says which product that cell orders. Two repeated
 * readings must agree on the products ordered; anything else becomes a question for the operator.
 */
export type { Vision } from '../documents/contract.js';
import type { Vision } from '../documents/contract.js';

const formLineSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sure'), productId: z.string().min(1), quantity: z.number() }),
  /** The two readings disagree; `readings` holds what each saw (null for nothing). */
  z.object({ kind: z.literal('unsure'), productId: z.string().min(1), readings: z.array(z.number().nullable()) }),
]);
export type FormLine = z.infer<typeof formLineSchema>;
export type FormReading = { form: OrderForm; lines: FormLine[] };

export { renderPdfPages as scannedPages } from '../documents/pdf-pages.js';
export { identify, enlarged } from '../documents/templates.js';
import { identify, enlarged, readCells } from '../documents/templates.js';
import type { CellRow, DocumentTemplate, DocumentResult } from '../documents/contract.js';
/** Products one reading orders, by product ID. One entry per row with one field per column keeps the model reading across rows. */
export async function readOnce(page: Buffer, form: OrderForm, vision: Vision): Promise<Record<string, number>> {
  return mapCells(await readCells(page, form, vision), form);
}

function mapCells(rows: CellRow[], form: OrderForm): Record<string, number> {
  const ordered: Record<string, number> = {};
  for (const row of rows as Record<string, unknown>[]) for (const column of form.columns) {
    const written = row[column.id];
    const value = typeof written === 'number' && written > 0 ? written : written === true ? 1 : 0;
    // Several cells may order the same product: a mark read on a neighbouring cell ordering it still counts once.
    const productId = form.rows[(row.row as number) - 1]?.cells[column.id]?.productId;
    if (value && productId !== undefined) ordered[productId] = (ordered[productId] ?? 0) + value;
  }
  return ordered;
}

/** What both readings order is kept; every difference becomes a doubtful line. */
const compareIds = (a: string, b: string) => /^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0;
export function mergeReadings(a: Record<string, number>, b: Record<string, number>): FormLine[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(compareIds).map(productId => a[productId] === b[productId]
    ? { kind: 'sure' as const, productId, quantity: a[productId]! }
    : { kind: 'unsure' as const, productId, readings: [a[productId] ?? null, b[productId] ?? null] });
}

/** Reads the form twice and keeps only what both readings agree on. */
export async function readForm(image: Buffer, form: OrderForm, vision: Vision): Promise<FormLine[]> {
  const page = await enlarged(image);
  const [a, b] = await Promise.all([0, 1].map(() => readOnce(page, form, vision)));
  return mergeReadings(a!, b!);
}

const bytes = z.custom<Buffer>(value => Buffer.isBuffer(value), 'Expected image bytes');

/**
 * One page as a Mastra workflow: identify → two readings in parallel → merge, each step visible in traces.
 * Snapshots are off so page images are never stored.
 */
export function createOrderFormWorkflow(forms: OrderForm[], vision: Vision) {
  const identified = z.object({ image: bytes, formId: z.string().nullable() });
  const ordered = z.object({ ordered: z.record(z.string(), z.number()) });
  const identifyStep = createStep({
    id: 'identify', inputSchema: z.object({ page: bytes }), outputSchema: identified,
    execute: async ({ inputData }) => {
      const { image, form } = await identify(inputData.page, forms, vision);
      return { image, formId: form?.id ?? null };
    },
  });
  const reading = (id: string) => createStep({
    id, inputSchema: identified, outputSchema: ordered,
    execute: async ({ inputData }) => {
      const form = forms.find(f => f.id === inputData.formId);
      return { ordered: form ? await readOnce(await enlarged(inputData.image), form, vision) : {} };
    },
  });
  const mergeStep = createStep({
    id: 'merge', inputSchema: z.record(z.string(), ordered),
    outputSchema: z.object({ image: bytes, formId: z.string().nullable(), lines: z.array(formLineSchema) }),
    execute: async ({ inputData, getStepResult }) => {
      const { image, formId } = getStepResult(identifyStep);
      return { image, formId, lines: formId ? mergeReadings(inputData['read-1']?.ordered ?? {}, inputData['read-2']?.ordered ?? {}) : [] };
    },
  });
  return createWorkflow({ id: 'read-order-form', inputSchema: z.object({ page: bytes }), outputSchema: mergeStep.outputSchema, options: { shouldPersistSnapshot: () => false } })
    .then(identifyStep).parallel([reading('read-1'), reading('read-2')]).then(mergeStep).commit();
}

/** Text handed to extraction. Product IDs come from the template, so the model copies rather than matches them. */
export function formText(reading: FormReading, names: Map<string, string>, tierName: string | undefined, it: boolean) {
  const say = (key: Parameters<typeof copy>[1], vars?: Parameters<typeof copy>[2]) => copy(it ? 'it' : 'en', key, vars);
  const name = (id: string) => `${names.get(id) ?? '?'} [productId ${id}]`;
  const prices = tierName ? say('formPrices', { tier: tierName, tierId: reading.form.priceTier ?? '' }) : '';
  const header = say('formHeader', { name: reading.form.name, prices });
  const lines = reading.lines.map(line => {
    if (line.kind === 'sure') return `${line.quantity} × ${name(line.productId)}`;
    const seen = line.readings.map(r => r ?? say('formNothing')).join(say('formAnd'));
    return say('formUnclear', { product: name(line.productId), seen });
  });
  return [header, ...(lines.length ? lines : [say('formEmpty')])].join('\n');
}

/** Strip business bindings before crossing the document service boundary. */
export function documentTemplates(forms: OrderForm[]): DocumentTemplate[] {
  return forms.map(({ id, name, headings, columns, rows }) => ({
    id, name, headings: [...headings], columns: columns.map(c => ({ ...c })),
    rows: rows.map(({ code, label }) => ({ code, label })),
  }));
}

/** Resolve document observations against business configuration, outside the reader. */
export function documentForms(result: DocumentResult, forms: OrderForm[]): FormReading[] {
  return result.pages.flatMap(page => {
    if (!page.template) return [];
    const form = forms.find(f => f.id === page.template!.id);
    if (!form) throw new Error('Unknown document template');
    const [a, b] = page.template.readings;
    return [{ form, lines: mergeReadings(mapCells(a, form), mapCells(b, form)) }];
  });
}
