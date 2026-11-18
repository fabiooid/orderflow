import type { Client, Product } from './types.js';

/** Most choices shown to the operator for one question. */
export const MAX_CHOICES = 10;

/** Fields used to find a customer: legal name, everyday name in notes, contact person, and street when the place-name lives there. */
export type ClientSearchRecord = Pick<Client, 'name'> & Partial<Pick<Client, 'id' | 'vatNumber' | 'city' | 'street' | 'notes' | 'contactPerson'>>;

export function normalize(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Same business name, or the same country and VAT number. */
export function sameClient(existing: { name: string; country: string; vatNumber?: string }, incoming: { name?: string; country?: string; vatNumber?: string }) {
  if (normalize(existing.name) === normalize(incoming.name ?? '')) return true;
  return Boolean(existing.vatNumber && incoming.vatNumber && existing.country === incoming.country && normalize(existing.vatNumber) === normalize(incoming.vatNumber));
}

export function isTester(product: Product) {
  return normalize(`${product.name} ${product.code}`).split(' ').includes('tester');
}

export function asksForTester(query: string) {
  return normalize(query).split(' ').some(token => token.startsWith('tester'));
}

const DENIES_TESTER = /\b(non|no|not|senza|without)\s+(?:a\s+)?tester/i;

/** A tester mark, or the word in the query, unless the operator excluded testers. */
export function lineWantsTester(line: { query: string; tester?: boolean }) {
  if (DENIES_TESTER.test(line.query)) return false;
  return line.tester === true || asksForTester(line.query);
}

/** Query used to resolve a line: keep a tester fact even when the printed sale code is the only wording. */
export function testerQuery(line: { query: string; tester?: boolean }) {
  const query = line.query.trim();
  if (!lineWantsTester(line) || asksForTester(query)) return query;
  return `${query} tester`;
}

function testerContentTokens(query: string) {
  return normalize(query).split(' ').filter(token => token && !token.startsWith('tester') && token !== 'sample' && token !== 'campion' && token !== 'prova');
}

/**
 * True when two tester lines are the same source fact under different wording (a sale code plus tester flag vs
 * an explicit tester query). Distinct quantities stay separate. Sale+tester is not this: the sale line does not want a tester.
 */
export function testerRestatementOf(
  left: { query: string; quantity?: number; tester?: boolean },
  right: { query: string; quantity?: number; tester?: boolean },
) {
  if (!lineWantsTester(left) || !lineWantsTester(right)) return false;
  if (left.quantity !== undefined && right.quantity !== undefined && left.quantity !== right.quantity) return false;
  if (normalize(testerQuery(left)) === normalize(testerQuery(right))) return true;
  const a = testerContentTokens(testerQuery(left));
  const b = testerContentTokens(testerQuery(right));
  if (!a.length || !b.length) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.every(token => longer.includes(token));
}

// Dropping a final vowel lets Italian singular and plural match (candele/candela, saponi/sapone).
function tokens(query: string) {
  return normalize(query).split(' ').filter(Boolean).map(t => t.length > 4 ? t.replace(/[aeio]$/, '') : t);
}

function productText(product: Product) {
  return normalize(`${product.name} ${product.code} ${product.description}`);
}

function contains(text: string, token: string) {
  return token.length <= 2 ? text.split(' ').includes(token) : text.includes(token);
}

function eligible(query: string, products: Product[]) {
  const wantsTester = asksForTester(query);
  return products.filter(p => isTester(p) === wantsTester);
}

/** Catalogue codes: digits or a hyphenated token, not a single name word such as a scent. */
function codeLike(code: string) {
  return code.length >= 3 && (/\d/.test(code) || /[A-Za-z][-_][A-Za-z0-9]/.test(code));
}

/**
 * Catalogue records whose code is the whole query, or a whole token inside it.
 * Letter-only names are not treated as SKUs when they appear as ordinary words.
 */
export function productCodesIn(query: string, products: Product[]): Product[] {
  if (!normalize(query)) return [];
  return products.filter(p => {
    if (!p.code) return false;
    if (normalize(p.code) === normalize(query)) return true;
    return codeLike(p.code) && nameInText(query, p.code);
  });
}

function scoredAgainst(query: string, pool: Product[]) {
  const words = tokens(query);
  if (!words.length) return [];
  return pool
    .map(product => ({ product, score: words.filter(token => contains(productText(product), token)).length }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * Catalogue tester records that correspond to this request. Sale SKUs printed on a form locate the
 * ordinary product; testers are matching tester records by catalogue name text, not a code convention.
 * Several equally good testers stay ambiguous; none means no tester, not the sale SKU.
 */
export function correspondingTesters(query: string, products: Product[]): Product[] {
  const testers = products.filter(isTester);
  if (!testers.length) return [];
  const q = normalize(query);
  const exact = testers.filter(p => normalize(p.code) === q || normalize(p.name) === q);
  if (exact.length) return exact;
  const testerCodes = productCodesIn(query, testers);
  if (testerCodes.length) return testerCodes;
  const sales = productCodesIn(query, products.filter(p => !isTester(p)));
  const identity = sales.length
    ? sales.map(sale => `${sale.name} ${sale.description}`).join(' ')
    : tokens(query).filter(token => !token.startsWith('tester')).join(' ');
  const hits = scoredAgainst(identity, testers);
  if (!hits.length) return [];
  const best = hits[0]!.score;
  return hits.filter(entry => entry.score === best).map(entry => entry.product);
}

/** Products containing every word of the query, or an exact name or unique catalogue code. */
export function matchProducts(query: string, products: Product[]): Product[] {
  const q = normalize(query);
  const wantsTester = asksForTester(query);
  const exact = products.filter(p => normalize(p.code) === q || normalize(p.name) === q);
  if (exact.length && (!wantsTester || exact.every(isTester))) return exact;
  const codes = productCodesIn(query, products);
  if (codes.length === 1 && (!wantsTester || isTester(codes[0]!))) return codes;
  if (wantsTester) return correspondingTesters(query, products);
  const words = tokens(query);
  if (!words.length) return [];
  return eligible(query, products).filter(p => {
    const text = productText(p);
    return words.every(token => contains(text, token));
  });
}

function scoredHits(query: string, products: Product[]) {
  const words = tokens(query);
  return eligible(query, products)
    .map(product => {
      const text = productText(product);
      return { product, score: words.filter(token => contains(text, token)).length, text };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Products sharing any word with the query, best first. Loose on purpose: the agent decides which one was meant. */
export function searchCatalogue(query: string, products: Product[]): Product[] {
  if (!normalize(query)) return [];
  const wantsTester = asksForTester(query);
  const exact = products.filter(p => normalize(p.code) === normalize(query) || normalize(p.name) === normalize(query));
  if (exact.length && (!wantsTester || exact.every(isTester))) return exact;
  const codes = productCodesIn(query, products);
  if (codes.length === 1 && (!wantsTester || isTester(codes[0]!))) return codes;
  if (wantsTester) return correspondingTesters(query, products).slice(0, 15);
  return scoredHits(query, products).slice(0, 15).map(entry => entry.product);
}

/**
 * When no product has every requested word, keep real products for each word that does appear.
 * A word that matches many products must not crowd out a word that matches few.
 */
export function relatedProducts(query: string, products: Product[]): Product[] {
  if (!normalize(query)) return [];
  const exact = products.filter(p => normalize(p.code) === normalize(query) || normalize(p.name) === normalize(query));
  if (exact.length) return exact;
  const words = tokens(query);
  if (!words.length) return [];
  const hits = scoredHits(query, products);
  if (!hits.length) return [];
  const byWord = words.map(word => hits.filter(entry => contains(entry.text, word)).map(entry => entry.product));
  const result: Product[] = [];
  const seen = new Set<string>();
  for (let round = 0; result.length < 15; round++) {
    let added = false;
    for (const group of byWord) {
      const product = group[round];
      if (!product || seen.has(product.id)) continue;
      seen.add(product.id);
      result.push(product);
      added = true;
      if (result.length >= 15) break;
    }
    if (!added) break;
  }
  return result;
}

function clientText(client: ClientSearchRecord) {
  return normalize([client.name, client.vatNumber, client.city, client.notes, client.contactPerson, client.street].filter(Boolean).join(' '));
}

/** Legal name, everyday name in notes, and contact person: stronger than the same words in a street. */
function identityText(client: ClientSearchRecord) {
  return normalize([client.name, client.notes, client.contactPerson].filter(Boolean).join(' '));
}

function businessIdentityText(client: ClientSearchRecord) {
  return normalize([client.name, client.notes].filter(Boolean).join(' '));
}

/** Leading words in “Cliente [name]” / “Customer [name]” utterances, not the business name. */
const NAMING_ROLE_WORDS = new Set(['cliente', 'customer', 'client', 'buyer', 'destinatario', 'intestatario']);

/** Trade or legal-form words that name a kind of account, not one account. */
const GENERIC_ACCOUNT_WORDS = new Set([
  'srl', 'spa', 'sas', 'snc', 'ltd', 'llc', 'inc', 'gmbh', 'plc', 'corp', 'bv', 'nv',
  'hotel', 'albergo', 'locanda', 'shop', 'store', 'negozio', 'pharmacy', 'farmacia',
  'cafe', 'caffe', 'coffee', 'restaurant', 'ristorante', 'bar', 'farm', 'inn', 'studio',
  'company', 'group', 'deli', 'bakery', 'bistro', 'trattoria', 'pizzeria', 'market',
  'trading', 'agriturismo', 'lodge', 'resort',
]);

/**
 * Same kind of place, in the languages operators actually type. A "negozio" hint should hit a shop
 * note, and "albergo" should hit hotel, without one-business aliases.
 */
const ACCOUNT_TYPE_FAMILIES: readonly (readonly string[])[] = [
  ['hotel', 'albergo', 'locanda'],
  ['shop', 'store', 'negozio'],
  ['pharmacy', 'farmacia'],
  ['cafe', 'caffe', 'coffee'],
  ['restaurant', 'ristorante'],
];

function typeFamily(word: string) {
  return ACCOUNT_TYPE_FAMILIES.find(family => family.includes(word)) ?? [word];
}

/** Street-label filler: useful place words still show; via/road/2 do not. */
const STREET_FILLER = new Set([
  'via', 'viale', 'corso', 'piazza', 'strada', 'vicolo', 'street', 'road', 'lane', 'walk',
  'dock', 'way', 'avenue', 'rue', 'plaza', 'square',
]);

function distinctivePlaceWords(value: string) {
  return normalize(value).split(' ').filter(word => word.length > 2 && !/^\d+$/.test(word) && !STREET_FILLER.has(word) && !GENERIC_ACCOUNT_WORDS.has(word));
}

function addsDistinctivePlace(existing: string, extra: string) {
  const have = new Set(distinctivePlaceWords(existing));
  return distinctivePlaceWords(extra).some(word => !have.has(word));
}

function clientContains(text: string, token: string) {
  return typeFamily(token).some(needle => contains(text, needle));
}

function hitsText(text: string, word: string, allowNearMiss: boolean) {
  if (clientContains(text, word)) return true;
  return allowNearMiss && text.split(' ').filter(Boolean).some(token => oneLetterOff(word, token));
}

function leftoverWords(text: string, queryWords: string[], allowNearMiss: boolean) {
  return queryWords.filter(word => !hitsText(text, word, allowNearMiss));
}

/** First or first-and-last name: a few letter tokens, not a trade or legal-form word. */
function looksLikePersonName(words: string[]) {
  return words.length >= 1 && words.length <= 2
    && words.every(word => word.length >= 3 && word.length <= 16 && /^[a-z]+$/u.test(word) && !GENERIC_ACCOUNT_WORDS.has(word));
}

/** True when `value` appears as a whole word in the operator's text. */
export function nameInText(text: string, value: string) {
  return !!normalize(value) && ` ${normalize(text)} `.includes(` ${normalize(value)} `);
}

export function exactClients<T extends ClientSearchRecord>(query: string, clients: T[]): T[] {
  const q = normalize(query);
  return q ? clients.filter(c => normalize(c.name) === q || normalize(c.vatNumber ?? '') === q) : [];
}

/** True when the words differ by one substitution, or by one insertion or deletion that is not only an extra or missing ending. Short tokens stay exact. */
function oneLetterOff(left: string, right: string): boolean {
  if (left === right || left.length < 4 || right.length < 4) return false;
  const gap = Math.abs(left.length - right.length);
  if (gap > 1) return false;
  const [shorter, longer] = left.length < right.length ? [left, right] : [right, left];
  if (gap === 0) {
    let diffs = 0;
    for (let i = 0; i < shorter.length; i++) {
      if (shorter[i] !== longer[i] && ++diffs > 1) return false;
    }
    return diffs === 1;
  }
  let skipped = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] === longer[i + skipped]) continue;
    if (skipped || shorter[i] !== longer[i + 1]) return false;
    skipped = 1;
  }
  // An extra or missing letter only at the end is a small ending change, not a mid-word slip.
  return skipped === 1;
}

/** True when one distinctive word is the other plus a short extra or missing ending. Not general spelling correction. */
function smallEndingOff(left: string, right: string): boolean {
  if (left === right || left.length < 4 || right.length < 4) return false;
  const [shorter, longer] = left.length < right.length ? [left, right] : [right, left];
  if (!longer.startsWith(shorter)) return false;
  const extra = longer.length - shorter.length;
  return extra >= 1 && extra <= Math.min(3, Math.floor(shorter.length / 2));
}

function clientScore(queryWords: string[], client: ClientSearchRecord, allowNearMiss = false, allowEnding = false) {
  const text = clientText(client);
  const haystack = allowNearMiss || allowEnding ? text.split(' ').filter(Boolean) : [];
  return queryWords.filter(word => clientContains(text, word)
    || (allowNearMiss && haystack.some(token => oneLetterOff(word, token)))
    || (allowEnding && haystack.some(token => smallEndingOff(word, token)))).length;
}

/**
 * Distinctive name, notes, or contact-person hits whose leftover words look like a person's name,
 * not another business. Street-only hits stay out of this list.
 */
function personNameSuggestions<T extends ClientSearchRecord>(words: string[], clients: T[]): T[] {
  const scored = clients.flatMap(client => {
    const leftover = leftoverWords(identityText(client), words, true);
    if (!leftover.length || leftover.length === words.length) return [];
    const distinctive = words.filter(word => !GENERIC_ACCOUNT_WORDS.has(word) && hitsText(identityText(client), word, true));
    if (!distinctive.length || !looksLikePersonName(leftover)) return [];
    const leftoverIsAnotherBusiness = leftover.some(word => GENERIC_ACCOUNT_WORDS.has(word) || clients.some(other => other !== client
      && !GENERIC_ACCOUNT_WORDS.has(word) && hitsText(businessIdentityText(other), word, true)));
    if (leftoverIsAnotherBusiness) return [];
    return [{ client, score: distinctive.length }];
  });
  const best = Math.max(0, ...scored.map(entry => entry.score));
  return best ? scored.filter(entry => entry.score === best).map(entry => entry.client) : [];
}

function everyWordHits<T extends ClientSearchRecord>(words: string[], clients: T[], allowNearMiss: boolean, allowEnding = false) {
  return clients.filter(client => clientScore(words, client, allowNearMiss, allowEnding) === words.length);
}

/**
 * Clients whose legal name, VAT, city, notes, contact person or street contain every word of the query,
 * or an exact name or VAT. A distinctive word may be one letter off when no exact-word hit exists.
 * Extra or missing endings are not locked here; search still offers them for confirmation.
 */
export function matchClients<T extends ClientSearchRecord>(query: string, clients: T[]): T[] {
  const exact = exactClients(query, clients);
  if (exact.length) return exact;
  const words = normalize(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const exactWords = everyWordHits(words, clients, false);
  return exactWords.length ? exactWords : everyWordHits(words, clients, true);
}

export function sameClientIds<T extends ClientSearchRecord>(left: T[], right: T[]) {
  if (left.length !== right.length) return false;
  const ids = new Set(left.map(client => client.id));
  return right.every(client => ids.has(client.id));
}

/**
 * Find customers by the name people use, not only the legal name. A distinctive word that is one letter
 * off still counts. A small extra or missing ending on a distinctive word still suggests the account
 * when no exact-word hit exists. Prefer every-word hits; if a leftover personal name hides a complete
 * match, still suggest the account whose legal name, notes, or contact person has the distinctive
 * words — not a weaker street-only hit. If a tighter refine (a hint such as hotel or shop) finds nobody,
 * fall back to siblings that share the remaining distinctive words, not every account of the same generic type.
 * A leading role word that is not on any record is dropped so “Cliente [name]” still finds the name.
 */
export function searchClients<T extends ClientSearchRecord>(query: string, clients: T[]): T[] {
  const words = normalize(query).split(' ').filter(Boolean);
  while (words.length > 1 && NAMING_ROLE_WORDS.has(words[0]!) && !clients.some(client => hitsText(clientText(client), words[0]!, true))) {
    words.shift();
  }
  const matched = matchClients(words.join(' '), clients);
  const named = words.length ? personNameSuggestions(words, clients) : [];
  if (named.length) {
    const identityComplete = matched.filter(client => leftoverWords(identityText(client), words, true).length === 0);
    return identityComplete.length ? identityComplete : named;
  }
  if (matched.length) return matched;
  if (!words.length) return [];
  const extraEnding = everyWordHits(words, clients, true, true);
  if (extraEnding.length) return extraEnding;
  const scored = clients.map(client => ({ client, score: clientScore(words, client, true) })).filter(entry => entry.score > 0);
  const best = Math.max(0, ...scored.map(entry => entry.score));
  // A single leftover word is often just the kind of business (hotel, pharmacy, spa). That is not enough
  // to offer every account of that type. Two or more shared words still surface sibling picks.
  if (best < Math.max(2, words.length - 1)) return [];
  return scored.filter(entry => entry.score === best).map(entry => entry.client);
}

/** Button label: legal name, then the everyday name from notes or the contact person, then street when it still adds a place word. */
export function clientPickLabel(client: { name: string; code?: string; city?: string; country?: string; vatNumber?: string; notes?: string; contactPerson?: string; street?: string; aliases?: string[] }) {
  const extra = [...new Set([...(client.aliases ?? []), client.notes?.trim() ?? '', client.contactPerson?.trim() ?? ''].filter(value => value && !normalize(client.name).includes(normalize(value))))];
  const soFar = [client.name, ...extra, client.city ?? ''].join(' ');
  const street = client.street?.trim() ?? '';
  if (street && addsDistinctivePlace(soFar, street)) extra.push(street);
  return [client.code, client.name, ...extra, client.city, client.country, client.vatNumber].filter(Boolean).join(' — ');
}

const SIZE_UNITS: Record<string, number> = { ml: 1, cl: 10, l: 1000, lt: 1000, litro: 1000, litri: 1000, g: 1, gr: 1, kg: 1000, mm: 1, cm: 10 };

/** Normalised size tokens such as `volume:250`. Catalogue names write litres as "5lt"; documents as "5 L". */
export function measureSizes(text: string) {
  return [...text.toLowerCase().matchAll(/(\d+(?:[.,]\d+)?)\s*(ml|cl|kg|gr|cm|mm|litri|litro|lt|l|g)\b/g)]
    .map(([, n, unit]) => `${['ml', 'cl', 'l', 'lt', 'litro', 'litri'].includes(unit!) ? 'volume' : ['mm', 'cm'].includes(unit!) ? 'length' : 'weight'}:${Number(n!.replace(',', '.')) * SIZE_UNITS[unit!]!}`);
}

/** Sizes that identify the catalogue record itself, not kit contents in a longer description. */
export function productIdentitySizes(product: Pick<Product, 'code' | 'name'>) {
  return measureSizes(`${product.code} ${product.name}`);
}

/**
 * Operator-requested sizes for this line. Kit contents printed only in an attachment are not
 * constraints. A size the operator typed is a constraint. A size that appears only in the model
 * query, with no attachment source, is treated as an operator request so it cannot silently pass.
 */
export function explicitLineSizes(lineQuery: string, operatorWords: string, attachmentText = '') {
  const wordSizes = new Set(measureSizes(operatorWords));
  const attachSizes = new Set(measureSizes(attachmentText));
  return [...new Set(measureSizes(lineQuery))].filter(size => {
    if (wordSizes.has(size)) return true;
    if (attachSizes.has(size)) return false;
    return true;
  });
}

/** "A oppure B" (or "A or B") naming catalogue products exactly, such as a doubtful value read from an order form; anything before a colon is a label. */
export function namedAlternatives(query: string, products: Product[]): Product[] {
  const parts = query.replace(/^[^:]*:\s*/, '').split(/\s+(?:oppure|or)\s+/i);
  if (parts.length < 2) return [];
  const found = parts.map(part => products.filter(p => normalize(p.name) === normalize(part)));
  return found.every(f => f.length === 1) ? found.map(f => f[0]!) : [];
}
