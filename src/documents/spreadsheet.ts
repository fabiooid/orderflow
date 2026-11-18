import ExcelJS from 'exceljs';
import type { DocumentFile } from './contract.js';

/** Transport MIME types a channel may admit as a spreadsheet before the bytes are sniffed. */
export const SPREADSHEET_MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/csv',
  'application/csv',
  'text/comma-separated-values',
] as const;

const MARK = /^(x+|✓|✔|☑|yes|y|si|sì|ok|v|true)$/iu;
const TESTER_ORDER = /^(?:a\s+)?(?:\d+\s+)?(tester|sample|campion|prova)s?$/iu;
const TESTER_POLICY = /\b(no|not|non|senza|without)\s+(?:a\s+|an\s+)?(tester|sample|campion|prova)|(tester|sample|campion|prova)s?.{0,80}\b(not provided|non previsti|cost|costs|prezzo)|\b(not provided|non previsti)\b/iu;
const TESTER_HINT = /\b(tester|sample|campion|prova)\b/iu;
const HEADER_HINT = /\b(qty|qta|q\.?t[aàe]?|quantity|quantit[aà]|pz|pcs|order|ordine|pieces|pezzi|tester|sample|campion|prova|code|sku|codice|product|prodotto|articolo|descrizione|price|prezzo)\b/iu;
const QTY_HINT = /\b(qty|qta|q\.?t[aàe]?|quantity|quantit[aà]|pz|pcs|order|ordine|pieces|pezzi)\b/iu;
const PRICE_HINT = /\b(price|prezzo|amount|importo|total|totale|vat|iva)\b/iu;
const CUSTOMER_LABEL = /\b(customer|cliente|buyer|bill\s*to|sold\s*to|destinatario|intestatario)\b/iu;
const MAX_SHEETS = 20;
const MAX_ROWS = 500;
const MAX_COLS = 40;

type Cell = { text: string; number: number | null; mark: boolean };
type ColumnKind = 'printed' | 'quantity' | 'mark';

/** True when a channel filename or MIME hint is a spreadsheet, independent of shop layout. */
export function spreadsheetHint(mimeType: string, fileName = '') {
  const mime = mimeType.toLowerCase();
  const name = fileName.toLowerCase();
  return (SPREADSHEET_MIME as readonly string[]).includes(mime) || /\.(xlsx|xlsm|xls|ods|csv)$/.test(name);
}

function isZip(bytes: Uint8Array) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

function isCsvHint(file: DocumentFile) {
  const mime = file.mimeType.toLowerCase();
  return mime === 'text/csv' || mime === 'application/csv' || mime === 'text/comma-separated-values' || mime.endsWith('+csv');
}

/** Content, not the MIME label, decides whether these bytes are a workbook or CSV. */
export function isSpreadsheetFile(file: DocumentFile) {
  const bytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
  if (isZip(bytes) || isCsvHint(file)) return true;
  if (bytes.length >= 3 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11) return true;
  return false;
}

function cellOf(raw: unknown): Cell {
  if (raw == null || raw === '') return { text: '', number: null, mark: false };
  if (typeof raw === 'boolean') return { text: raw ? 'true' : '', number: null, mark: raw };
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { text: String(raw), number: raw, mark: false };
  }
  if (typeof raw === 'object') {
    const value = raw as { result?: unknown; text?: unknown; richText?: { text?: string }[]; hyperlink?: unknown };
    if (value.result !== undefined) return cellOf(value.result);
    if (typeof value.text === 'string') return cellOf(value.text);
    if (Array.isArray(value.richText)) return cellOf(value.richText.map(part => part.text ?? '').join(''));
  }
  const text = String(raw).trim();
  if (!text) return { text: '', number: null, mark: false };
  if (MARK.test(text)) return { text, number: 1, mark: true };
  if (TESTER_ORDER.test(text) && !TESTER_POLICY.test(text)) {
    const count = Number(/^(\d+)/.exec(text)?.[1] ?? '');
    return { text, number: Number.isFinite(count) && count > 0 ? count : null, mark: false };
  }
  const number = Number(text.replace(',', '.'));
  if (text !== '' && Number.isFinite(number) && /^-?\d+([.,]\d+)?$/.test(text)) {
    return { text, number, mark: false };
  }
  return { text, number: null, mark: false };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const body = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

async function workbookSheets(file: DocumentFile): Promise<string[][][]> {
  const bytes = Buffer.from(file.data);
  if (isCsvHint(file) && !isZip(bytes)) {
    return [parseCsv(bytes.toString('utf8'))];
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  } catch {
    throw new Error('Unsupported document format');
  }
  const sheets: string[][][] = [];
  for (const sheet of workbook.worksheets.slice(0, MAX_SHEETS)) {
    const dim = sheet.dimensions;
    if (!dim) continue;
    const rows: string[][] = [];
    const lastRow = Math.min(dim.bottom, dim.top + MAX_ROWS - 1);
    const lastCol = Math.min(dim.right, dim.left + MAX_COLS - 1);
    for (let r = dim.top; r <= lastRow; r++) {
      const row: string[] = [];
      for (let c = dim.left; c <= lastCol; c++) row.push(display(sheet.getCell(r, c).value));
      rows.push(row);
    }
    sheets.push(rows);
  }
  return sheets;
}

function display(value: ExcelJS.CellValue): string {
  if (value == null || value === '') return '';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return String(value).trim();
  if (value instanceof Date) return '';
  if (typeof value === 'object') {
    if ('result' in value) return display(value.result as ExcelJS.CellValue);
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map(part => part.text).join('').trim();
    if ('text' in value && typeof value.text === 'string') return value.text.trim();
  }
  return '';
}

function nonEmpty(row: Cell[]) {
  return row.some(cell => cell.text);
}

function productRows(rows: Cell[][]) {
  return rows.filter(row => row.some(cell => cell.text && cell.number == null && !cell.mark));
}

function fillRate(rows: Cell[][], column: number) {
  if (!rows.length) return 0;
  return rows.filter(row => row[column]?.text).length / rows.length;
}

function priceLike(values: number[]) {
  if (!values.length) return false;
  const decimals = values.filter(v => !Number.isInteger(v)).length;
  const typical = values.filter(v => v >= 0.5).length;
  return decimals > values.length / 2 || (typical === values.length && values.every(v => v >= 5 || !Number.isInteger(v)));
}

function columnNumbers(products: Cell[][], column: number) {
  return products.map(row => row[column]?.number).filter((n): n is number => n != null && n > 0);
}

function isTesterOrder(cell: Cell, heading = '') {
  if (!cell.text || TESTER_POLICY.test(cell.text) || (cell.text.length > 28 && TESTER_HINT.test(cell.text))) return false;
  return cell.mark || TESTER_ORDER.test(cell.text) || (TESTER_HINT.test(heading) && cell.number != null && cell.number > 0 && cell.number <= 2);
}

function classifyColumns(header: string[], data: Cell[][]): ColumnKind[] {
  const products = productRows(data);
  const kinds: ColumnKind[] = header.map((heading, column) => {
    const cells = products.map(row => row[column] ?? { text: '', number: null, mark: false });
    const filled = cells.filter(cell => cell.text);
    const numbers = filled.map(cell => cell.number).filter((n): n is number => n != null && n > 0);
    const marks = filled.filter(cell => isTesterOrder(cell, heading)).length;
    const rate = fillRate(products, column);
    if (TESTER_HINT.test(heading) && marks) return 'mark';
    if (PRICE_HINT.test(heading)) return 'printed';
    if (QTY_HINT.test(heading) && numbers.length) return 'quantity';
    if (marks && marks >= filled.length / 2 && rate < 0.7) return 'mark';
    if (numbers.length && rate < 0.7) return 'quantity';
    if (numbers.length && rate >= 0.7 && !priceLike(numbers) && header.some((_, i) => i !== column && priceLike(columnNumbers(products, i)))) {
      return TESTER_HINT.test(heading) ? 'mark' : 'quantity';
    }
    return 'printed';
  });
  const sparse = kinds.flatMap((kind, i) => kind === 'quantity' ? [i] : []);
  if (sparse.length >= 2) {
    const ordinary = sparse.find(i => columnNumbers(products, i).some(n => n > 1));
    for (const i of sparse) {
      const numbers = columnNumbers(products, i);
      if (ordinary !== undefined && i !== ordinary && numbers.length && numbers.every(n => n === 1)) kinds[i] = 'mark';
    }
  }
  return kinds;
}

function headingScore(row: Cell[]) {
  const filled = row.filter(cell => cell.text);
  if (filled.length < 2) return -1;
  const labels = filled.filter(cell => cell.number == null && !cell.mark && cell.text.length <= 24).length;
  const hints = filled.filter(cell => HEADER_HINT.test(cell.text)).length;
  const long = filled.filter(cell => cell.text.length > 28 && !HEADER_HINT.test(cell.text)).length;
  return labels + hints * 4 - long * 5;
}

function tableStart(rows: Cell[][]) {
  let best = 0, score = -Infinity, bestHeading = -Infinity, firstHeader = 0;
  for (let i = 0; i < rows.length; i++) {
    const filled = rows[i]!.filter(cell => cell.text).length;
    if (filled < 2) continue;
    const heading = headingScore(rows[i]!);
    if (heading > bestHeading) { bestHeading = heading; firstHeader = i; }
    const following = rows.slice(i + 1, i + 6).filter(nonEmpty).length;
    const quantities = rows.slice(i + 1, i + 8).filter(row => row.some(cell => cell.number != null || cell.mark)).length;
    const next = (heading > 0 ? heading * 4 : 0) + filled + following + quantities * 2;
    if (next > score) { score = next; best = i; }
  }
  // Repeated table headers later on a filled sheet look denser; keep the first equally labelled header.
  return bestHeading > 0 ? firstHeader : best;
}

function preambleFields(rows: Cell[][], start: number) {
  const letterhead: string[] = [];
  const customer: string[] = [];
  for (const row of rows.slice(0, start)) {
    const cells = row.filter(cell => cell.text);
    if (!cells.length) continue;
    const joined = cells.map(cell => cell.text.replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ');
    if (CUSTOMER_LABEL.test(cells[0]!.text) || CUSTOMER_LABEL.test(joined)) {
      const value = cells.slice(1).map(cell => cell.text).filter(Boolean).join(', ');
      if (value) customer.push(cells.length === 2 ? `${cells[0]!.text}: ${value}` : joined);
      continue;
    }
    letterhead.push(joined);
  }
  return { letterhead, customer };
}

function headingLike(row: Cell[]) {
  if (row.some(cell => cell.number != null || cell.mark)) return false;
  return row.filter(cell => cell.text && HEADER_HINT.test(cell.text)).length >= 2;
}

function codeAndName(row: Cell[], kinds: ColumnKind[]) {
  const printed = row.map((cell, i) => ({ cell, i })).filter(({ i, cell }) => kinds[i] === 'printed' && cell.text && cell.number == null && !cell.mark);
  const codes = printed.filter(({ cell }) => cell.text.length <= 24 && !/\s{2,}/.test(cell.text) && /[A-Za-z0-9]/.test(cell.text) && (cell.text.length <= 12 || /[A-Za-z]/.test(cell.text) && /\d/.test(cell.text)));
  const code = (codes.sort((a, b) => a.cell.text.length - b.cell.text.length)[0] ?? printed[0])?.cell.text;
  const name = printed.filter(({ cell }) => cell.text !== code).sort((a, b) => b.cell.text.length - a.cell.text.length)[0]?.cell.text;
  return { code, name };
}

function extractSheet(rows: string[][]) {
  const width = Math.max(0, ...rows.map(row => row.length));
  const grid = rows.map(row => {
    const cells = row.map(cellOf);
    while (cells.length < width) cells.push({ text: '', number: null, mark: false });
    return cells;
  });
  const used = grid.filter(nonEmpty);
  if (used.length < 2) return { letterhead: [] as string[], customer: [] as string[], lines: [] as string[] };
  const start = tableStart(used);
  const headerRow = used[start]!;
  const allText = headerRow.every(cell => !cell.number && !cell.mark);
  const headings = allText ? headerRow.map((cell, i) => cell.text || `column ${i + 1}`) : headerRow.map((_, i) => `column ${i + 1}`);
  const data = (allText ? used.slice(start + 1) : used.slice(start)).map(row => {
    const next = row.slice();
    while (next.length < headings.length) next.push({ text: '', number: null, mark: false });
    return next;
  });
  const kinds = classifyColumns(headings, data);
  const preamble = preambleFields(used, start);
  if (!kinds.some(kind => kind === 'quantity' || kind === 'mark')) return { ...preamble, lines: [] };
  const lines: string[] = [];
  for (const row of data) {
    if (headingLike(row)) continue;
    const filled = headings.flatMap((heading, i) => {
      if (kinds[i] !== 'quantity' && kinds[i] !== 'mark') return [];
      const cell = row[i];
      if (!cell?.text) return [];
      const tester = kinds[i] === 'mark' || TESTER_HINT.test(heading);
      if (tester && !isTesterOrder(cell, heading)) return [];
      if (kinds[i] === 'quantity' && (cell.number == null || cell.number <= 0)) return [];
      const value = tester
        ? String(cell.number && cell.number > 0 ? cell.number : 1)
        : String(cell.number ?? cell.text);
      const label = tester ? 'tester' : kinds[i] === 'quantity' && heading.length > 24 ? 'Qty' : heading;
      return [{ heading: label, value, tester }];
    });
    if (!filled.length) continue;
    const { code, name } = codeAndName(row, kinds);
    const identity = [code, name].filter((value): value is string => Boolean(value));
    if (!identity.length) continue;
    const facts = filled.map(item => `${item.heading}: ${item.value}`);
    if (filled.some(item => item.tester) && !facts.some(item => TESTER_HINT.test(item))) facts.push('tester: 1');
    lines.push([...identity, ...facts].map(part => part.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | '));
  }
  return { ...preamble, lines };
}

/**
 * Read a workbook into labelled facts for the existing draft flow: product identity, filled quantities,
 * tester marks, and any non-empty customer header pairs. Sheets with no filled quantity or mark are omitted, so a
 * catalogue layout is not treated as the order. Printed prices stay off the lines; catalogue prices apply.
 * Unlabelled letterhead above the table is the supplier, not the customer.
 */
export async function readSpreadsheet(file: DocumentFile): Promise<string> {
  const sheets = await workbookSheets(file);
  const letterhead: string[] = [];
  const customer: string[] = [];
  const lines: string[] = [];
  for (const sheet of sheets) {
    const extracted = extractSheet(sheet);
    for (const field of extracted.letterhead) if (!letterhead.includes(field)) letterhead.push(field);
    for (const field of extracted.customer) if (!customer.includes(field)) customer.push(field);
    lines.push(...extracted.lines);
  }
  const oneLine = (field: string) => field.replace(/\s+/g, ' ').trim();
  return [
    ...letterhead.map(field => `Letterhead (supplier, not the customer): ${oneLine(field)}`),
    ...customer.map(field => `Header: ${oneLine(field)}`),
    ...lines,
  ].join('\n');
}
