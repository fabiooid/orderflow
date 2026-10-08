import sharp from 'sharp';
import { z } from 'zod';
import type { DocumentTemplate, Vision, CellRow } from './contract.js';

const sides = ['top', 'right', 'bottom', 'left'] as const;
/** Rotation that brings the side carrying the top of the text up. */
const turn: Record<(typeof sides)[number], number> = { top: 0, right: 270, bottom: 180, left: 90 };


const thumbnail = (image: Buffer) => sharp(image).resize({ width: 1000, height: 1000, fit: 'inside', withoutEnlargement: true }).png().toBuffer();

function describe(forms: DocumentTemplate[]) {
  return forms.map(f => `- ${f.id}: "${f.name}". Column headings: ${f.headings.join(' | ') || 'n/a'}. First rows: ${f.rows.slice(0, 3).map(r => r.label).join('; ')}`).join('\n');
}

/** Turns a page upright and says which configured form it is, if any. Upside-down checks are reliable; left/right guesses are not. */
export async function identify<T extends DocumentTemplate>(image: Buffer, forms: T[], vision: Vision): Promise<{ image: Buffer; form?: T }> {
  const ids: [string, ...string[]] = ['none', ...forms.map(f => f.id)];
  let upright = await sharp(image).rotate().toBuffer();
  const first = await vision([await thumbnail(upright)],
    `Printed text on this page reads normally when which edge of the image is at the top? Look at titles and table headings.\nIs the page one of these printed order forms? Answer none if not, or if unsure.\n${describe(forms)}`,
    z.object({ textTop: z.enum(sides), form: z.enum(ids) }));
  let formId = first.form;
  if (first.textTop !== 'top') {
    upright = await sharp(upright).rotate(turn[first.textTop]).toBuffer();
    const check = await vision([await thumbnail(upright)],
      `Is the printed text on this page upright or upside down? Is the page one of these printed order forms? Answer none if not, or if unsure.\n${describe(forms)}`,
      z.object({ text: z.enum(['upright', 'upside down', 'sideways']), form: z.enum(ids) }));
    if (check.text === 'upside down') upright = await sharp(upright).rotate(180).toBuffer();
    formId = check.form;
  }
  return { image: upright, form: forms.find(f => f.id === formId) };
}

/** Preserve the existing enlargement heuristic for the baseline; it cannot recover missing detail. */
export async function enlarged(image: Buffer) {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  const scale = Math.max(1, Math.min(3, 3000 / Math.max(width, height)));
  return scale === 1 ? image : sharp(image).resize(Math.round(width * scale), Math.round(height * scale), { kernel: 'lanczos3' }).sharpen().png().toBuffer();
}

function readPrompt(form: DocumentTemplate) {
  return `This is a customer's filled-in copy of the order form "${form.name}". Its printed rows are, in order:
${form.rows.map((r, i) => `${i + 1}. ${r.code || '(no code)'} — ${r.label}`).join('\n')}
Customers write in these columns:
${form.columns.map(c => `- ${c.id}: "${c.heading}" — ${c.value === 'quantity' ? 'a number of pieces, or null' : 'true when marked (such as an X)'}`).join('\n')}
Report each row that has anything handwritten, using the row numbers above, with what is written in each column. Read straight across from the printed code and description.
Column meanings are authoritative: numbers in quantity columns are quantities, never unit prices. An X or check in a mark column is true; a blank mark cell is false. Do not copy printed prices into quantity cells or infer prices from handwriting in these columns.
Handwriting is often written low in its cell and may touch the line below. Values in one row are written at the same height: place a mark by comparing its height with the numbers written in the other columns, not with the printed lines. Ignore rows that are not on this page.`;
}

/** Raw observations only: product bindings are deliberately absent. */
export async function readCells(page: Buffer, form: DocumentTemplate, vision: Vision): Promise<CellRow[]> {
  const columns = Object.fromEntries(form.columns.map(c => [c.id, c.value === 'quantity' ? z.number().nullable() : z.boolean()]));
  const schema = z.object({ rows: z.array(z.object({ row: z.number().int(), ...columns })) });
  const result = schema.parse(await vision([page], readPrompt(form), schema));
  return result.rows as CellRow[];
}
