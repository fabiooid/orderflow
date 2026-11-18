import type { PendingQuestion } from '../matching/resolver.js';
export type { PendingQuestion };

/** File-consent wording is not a customer confirmation. */
const FILE_CONSENT = /\b(prepara|prepare|crea(?:re)?(?:\s+un)?\s+ordine|create(?:\s+an?)?\s+order|importa|allegat|file|excel|xlsx|questa|this file)\b/i;
const AFFIRM = /^(sì|si|yes|ok|okay|va bene|confermo|quello|quella)\b/i;
const NO_SHIPPING = /\b(niente|nessun[ao]?)\s+(spedizione|consegna|addebito)|(?:no|without|senza)\s+(?:delivery|shipping|charge)|gratuita|free\s+(?:shipping|delivery)|no charge\b/i;
const SHIPPING_AMOUNT = /\b(?:spedizione|shipping|consegna|delivery|addebito)\b[^0-9]{0,24}(\d+(?:[.,]\d+)?)/i;
const AMOUNT_THEN_SHIPPING = /(\d+(?:[.,]\d+)?)\s*(?:€|eur|euro|usd|gbp)?\s*(?:di\s+)?(?:spedizione|shipping|consegna|delivery)\b/i;

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

/** Delivery charge the operator stated in this request's own words. `0` is no charge; `undefined` is unknown. */
export function statedShipping(operatorWords: string): number | undefined {
  if (!operatorWords.trim()) return undefined;
  if (NO_SHIPPING.test(operatorWords)) return 0;
  const match = SHIPPING_AMOUNT.exec(operatorWords) ?? AMOUNT_THEN_SHIPPING.exec(operatorWords);
  if (!match) return undefined;
  const value = Number(match[1]!.replace(',', '.'));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** True when this request's words or a non-empty customer header actually named a customer. */
export function customerNamedInRequest(query: string, operatorWords: string, attachmentText = '') {
  const q = query.trim();
  if (!q) return false;
  const header = /^\s*(?:header:\s*)?customer\s*[:|-]\s*(.+)$/im.exec(attachmentText)?.[1]?.trim() ?? '';
  return operatorWords.toLowerCase().includes(q.toLowerCase()) || (header.length > 0 && header.toLowerCase().includes(q.toLowerCase()));
}
