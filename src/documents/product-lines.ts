/**
 * Product lines already read from an attachment: labelled facts (`code | name | Qty: 2`),
 * not a shop layout. Used to persist those lines when the operator asked to prepare an order.
 */
const SKIP = /^(letterhead|header)\b/i;
const QTY = /\b(qty|qta|q\.?t[aàe]?|quantity|quantit[aà]|pz|pcs)\s*:\s*(\d+(?:[.,]\d+)?)/i;
const TESTER = /\b(tester|sample|campion|prova)\b/i;

export function productLinesFromReading(text: string): { query: string; quantity: number }[] {
  const lines: { query: string; quantity: number }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || SKIP.test(line) || !line.includes('|')) continue;
    const parts = line.split('|').map(part => part.trim()).filter(Boolean);
    const qtyPart = parts.find(part => QTY.test(part));
    const testerPart = parts.find(part => TESTER.test(part) && /:\s*\S+/.test(part));
    const quantity = qtyPart ? Number(QTY.exec(qtyPart)![2]!.replace(',', '.')) : testerPart ? 1 : NaN;
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const identity = parts.filter(part => part !== qtyPart && part !== testerPart);
    if (!identity.length) continue;
    const query = testerPart && !identity.some(part => TESTER.test(part)) ? `${identity.join(' ')} tester` : identity.join(' ');
    lines.push({ query, quantity });
  }
  return lines;
}
