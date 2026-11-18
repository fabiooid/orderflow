import type { PendingQuestion } from '../matching/resolver.js';
export type { PendingQuestion };

/** File-consent wording is not a customer confirmation. */
const FILE_CONSENT = /\b(prepara|prepare|crea(?:re)?(?:\s+un)?\s+ordine|create(?:\s+an?)?\s+order|importa|allegat|file|excel|xlsx|questa|this file)\b/i;
const AFFIRM = /^(sì|si|yes|ok|okay|va bene|confermo|quello|quella)\b/i;
const NO_CHARGE = /\b(?:niente|nessun[ao]?|no|without|senza)\s+(?:spedizione|consegna|addebito|delivery|shipping|charge)\b|\bgratuita\b|\bfree\s+(?:shipping|delivery)\b|\bno charge\b/gi;
const SHIPPING_AMOUNT = /\b(?:spedizione|shipping|consegna|delivery|addebito)\b[^0-9]{0,24}(\d+(?:[.,]\d+)?)/gi;
const AMOUNT_THEN_SHIPPING = /(\d+(?:[.,]\d+)?)\s*(?:€|eur|euro|usd|gbp)?\s*(?:di\s+)?(?:spedizione|shipping|consegna|delivery)\b/gi;

function parseAmount(raw: string) {
  const value = Number(raw.replace(',', '.'));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Last shipping statement in this text: a no-charge phrase or an amount next to a delivery word. */
function lastShippingStatement(text: string): number | undefined {
  if (!text.trim()) return undefined;
  const hits: { index: number; value: number }[] = [];
  for (const match of text.matchAll(NO_CHARGE)) hits.push({ index: match.index ?? 0, value: 0 });
  for (const match of text.matchAll(AMOUNT_THEN_SHIPPING)) {
    const value = parseAmount(match[1]!);
    if (value !== undefined) hits.push({ index: match.index ?? 0, value });
  }
  for (const match of text.matchAll(SHIPPING_AMOUNT)) {
    const value = parseAmount(match[1]!);
    if (value !== undefined) hits.push({ index: match.index ?? 0, value });
  }
  if (!hits.length) return undefined;
  hits.sort((a, b) => a.index - b.index || a.value - b.value);
  return hits.at(-1)!.value;
}

/** True when this message is only agreeing to prepare from a file, not naming a customer. */
export function isFileConsent(text: string) {
  const trimmed = text.trim();
  return AFFIRM.test(trimmed) && FILE_CONSENT.test(trimmed);
}

/** True when the operator clearly affirms the active named candidate and is not consenting to a file. */
export function isCustomerConfirmation(text: string, pending?: PendingQuestion, hasOpenCustomerQuestion = false) {
  if (!pending || pending.field !== 'client' || pending.ids.length !== 1 || !hasOpenCustomerQuestion) return false;
  const trimmed = text.trim();
  if (!AFFIRM.test(trimmed)) return false;
  if (isFileConsent(trimmed)) return false;
  return trimmed.length < 80;
}

/** Printed note the operator labelled (`nota:` / `note:`), without that role word. */
export function statedNote(text: string): string | undefined {
  const labelled = /(?:^|\n|,)\s*(?:nota|note)\s*:\s*(.+)$/i.exec(text.trim())?.[1]?.trim();
  return labelled || undefined;
}

/** Delivery charge the operator stated. This turn wins, then the last statement in the request. `0` is no charge; `undefined` is unknown. */
export function statedShipping(operatorWords: string, turnWords?: string): number | undefined {
  const fromTurn = turnWords?.trim() ? lastShippingStatement(turnWords) : undefined;
  if (fromTurn !== undefined) return fromTurn;
  return lastShippingStatement(operatorWords);
}

/** True when this request's words or a non-empty customer header actually named a customer. */
export function customerNamedInRequest(query: string, operatorWords: string, attachmentText = '') {
  const q = query.trim();
  if (!q) return false;
  const header = /^\s*(?:header:\s*)?customer\s*[:|-]\s*(.+)$/im.exec(attachmentText)?.[1]?.trim() ?? '';
  return operatorWords.toLowerCase().includes(q.toLowerCase()) || (header.length > 0 && header.toLowerCase().includes(q.toLowerCase()));
}

/** True when the operator asked to create a customer, not merely to prepare an order. */
export function operatorAskedToCreateCustomer(operatorWords: string) {
  return /\b(?:crea(?:re)?(?:\s+un)?|nuovo)\s+cliente\b/i.test(operatorWords)
    || /\b(?:create(?:\s+an?)?|new)\s+customer\b/i.test(operatorWords);
}

/** True when this message asks to create or add to an order, not merely to prepare a file. */
export function operatorAskedToCreateOrder(text: string) {
  return /\b(?:crea(?:re)?(?:\s+un)?(?:\s+nuovo)?\s+ordine|create(?:\s+an?)?(?:\s+new)?\s+order|nuovo ordine|new order)\b/i.test(text);
}

/** A count the operator stated in this message, when they are adding it to an order. */
export function statedLineQuantity(text: string) {
  const value = Number(/\b(\d+)\b/.exec(text)?.[1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** True when this message asks to drop the open unsaved request. */
export function operatorAskedToCancel(text: string) {
  return /\b(?:annulla(?:re|t[oa])?|lascia stare|non serve più|cancel(?:led| it)?|never mind|drop (?:it|the (?:order|request)))\b/i.test(text);
}

/** Customer name the operator labelled in this message (`cliente X` / `customer X`). */
export function labelledCustomerQuery(text: string) {
  const name = /^(?:cliente|customer)\s*[:\-]?\s+(.+)$/i.exec(text.trim())?.[1]?.trim();
  return name && name.length <= 80 ? name : undefined;
}

const folded = (value: string) => value.trim().toLowerCase();

/** True when a client search is grounded in this message, not a previous-chat guess. */
export function clientSearchNamedThisTurn(query: string, operatorWords: string, attachmentText = '') {
  const q = query.trim();
  if (!q) return false;
  if (customerNamedInRequest(q, operatorWords, attachmentText)) return true;
  const labelled = labelledCustomerQuery(operatorWords);
  if (labelled) {
    const a = folded(q), b = folded(labelled);
    return a.includes(b) || b.includes(a);
  }
  const spoken = operatorWords.trim();
  if (spoken.split(/\s+/).length <= 4 && spoken.length >= 3) {
    const a = folded(q), b = folded(spoken);
    return a.includes(b) || b.includes(a);
  }
  return false;
}
