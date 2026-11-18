/**
 * Product lines already read from an attachment: labelled facts (`code | name | Qty: 2`),
 * not a shop layout. Used to persist those lines when the operator asked to prepare an order.
 * A tester mark is its own line: the printed sale code stays identity, not the tester product.
 */
const SKIP = /^(letterhead|header)\b/i;
const QTY = /\b(qty|qta|q\.?t[aàe]?|quantity|quantit[aà]|pz|pcs)\s*:\s*(\d+(?:[.,]\d+)?)/i;
const TESTER = /\b(tester|sample|campion|prova)\b/i;
const TESTER_COUNT = /\b(tester|sample|campion|prova)\s*:\s*(\d+(?:[.,]\d+)?)/i;

export type ReadingLine = { query: string; quantity: number; tester?: true };

function identityQuery(parts: string[], qtyPart?: string, testerPart?: string) {
  return parts.filter(part => part !== qtyPart && part !== testerPart).join(' ');
}

function withTesterWord(query: string) {
  return TESTER.test(query) ? query : `${query} tester`;
}

export function productLinesFromReading(text: string): ReadingLine[] {
  const lines: ReadingLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || SKIP.test(line) || !line.includes('|')) continue;
    const parts = line.split('|').map(part => part.trim()).filter(Boolean);
    const qtyPart = parts.find(part => QTY.test(part));
    const testerPart = parts.find(part => TESTER.test(part) && /:\s*\S+/.test(part));
    const identity = identityQuery(parts, qtyPart, testerPart);
    if (!identity) continue;
    if (qtyPart) {
      const quantity = Number(QTY.exec(qtyPart)![2]!.replace(',', '.'));
      if (Number.isFinite(quantity) && quantity > 0) lines.push({ query: identity, quantity });
    }
    if (testerPart) {
      const counted = Number((TESTER_COUNT.exec(testerPart)?.[2] ?? '').replace(',', '.'));
      const quantity = Number.isFinite(counted) && counted > 0 ? counted : 1;
      lines.push({ query: withTesterWord(identity), quantity, tester: true });
    }
  }
  return lines;
}
