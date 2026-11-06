import type { Client, Product } from './types.js';

/** Most choices shown to the operator for one question. */
export const MAX_CHOICES = 10;

/** Fields used to find a customer: legal name, everyday name in notes, and street when the place-name lives there. */
export type ClientSearchRecord = Pick<Client, 'name'> & Partial<Pick<Client, 'id' | 'vatNumber' | 'city' | 'street' | 'notes'>>;

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

/** Products containing every word of the query, or an exact name or code. */
export function matchProducts(query: string, products: Product[]): Product[] {
  const q = normalize(query);
  const exact = products.filter(p => normalize(p.code) === q || normalize(p.name) === q);
  if (exact.length) return exact;
  const words = tokens(query);
  if (!words.length) return [];
  return eligible(query, products).filter(p => {
    const text = productText(p);
    return words.every(token => contains(text, token));
  });
}

/** Products sharing any word with the query, best first. Loose on purpose: the agent decides which one was meant. */
export function searchCatalogue(query: string, products: Product[]): Product[] {
  if (!normalize(query)) return [];
  const exact = products.filter(p => normalize(p.code) === normalize(query) || normalize(p.name) === normalize(query));
  if (exact.length) return exact;
  const words = tokens(query);
  return eligible(query, products)
    .map(product => {
      const text = productText(product);
      return { product, score: words.filter(token => contains(text, token)).length };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map(entry => entry.product);
}

function clientText(client: ClientSearchRecord) {
  return normalize([client.name, client.vatNumber, client.city, client.notes, client.street].filter(Boolean).join(' '));
}

function exactClients<T extends ClientSearchRecord>(query: string, clients: T[]): T[] {
  const q = normalize(query);
  return q ? clients.filter(c => normalize(c.name) === q || normalize(c.vatNumber ?? '') === q) : [];
}

/** True when the words differ by one substitution, insertion or deletion. Short tokens stay exact. */
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
  return true;
}

function clientScore(queryWords: string[], client: ClientSearchRecord, allowNearMiss = false) {
  const text = clientText(client);
  const haystack = allowNearMiss ? text.split(' ').filter(Boolean) : [];
  return queryWords.filter(word => contains(text, word) || (allowNearMiss && haystack.some(token => oneLetterOff(word, token)))).length;
}

function everyWordHits<T extends ClientSearchRecord>(words: string[], clients: T[], allowNearMiss: boolean) {
  return clients.filter(client => clientScore(words, client, allowNearMiss) === words.length);
}

/**
 * Clients whose legal name, VAT, city, notes or street contain every word of the query, or an exact
 * name or VAT. A distinctive word may be one letter off when no exact-word hit exists.
 */
export function matchClients<T extends ClientSearchRecord>(query: string, clients: T[]): T[] {
  const exact = exactClients(query, clients);
  if (exact.length) return exact;
  const words = normalize(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const exactWords = everyWordHits(words, clients, false);
  return exactWords.length ? exactWords : everyWordHits(words, clients, true);
}

/**
 * Find customers by the name people use, not only the legal name. A distinctive word that is one letter
 * off still counts. Prefer every-word hits; if a tighter refine (a hint such as hotel or shop) finds
 * nobody, fall back to siblings that share the remaining distinctive words, not every account of the
 * same generic type.
 */
export function searchClients<T extends ClientSearchRecord>(query: string, clients: T[]): T[] {
  const matched = matchClients(query, clients);
  if (matched.length) return matched;
  const words = normalize(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const scored = clients.map(client => ({ client, score: clientScore(words, client, true) })).filter(entry => entry.score > 0);
  const best = Math.max(0, ...scored.map(entry => entry.score));
  // A single leftover word is often just the kind of business (hotel, pharmacy, spa). That is not enough
  // to offer every account of that type. Two or more shared words still surface sibling picks.
  if (best < Math.max(2, words.length - 1)) return [];
  return scored.filter(entry => entry.score === best).map(entry => entry.client);
}

/** Button label: legal name, then the everyday name from notes when it adds something. */
export function clientPickLabel(client: { name: string; code?: string; city?: string; country?: string; vatNumber?: string; notes?: string; aliases?: string[] }) {
  const extra = [...new Set([...(client.aliases ?? []), client.notes?.trim() ?? ''].filter(value => value && !normalize(client.name).includes(normalize(value))))];
  return [client.code, client.name, ...extra, client.city, client.country, client.vatNumber].filter(Boolean).join(' — ');
}

/** "A oppure B" (or "A or B") naming catalogue products exactly, such as a doubtful value read from an order form; anything before a colon is a label. */
export function namedAlternatives(query: string, products: Product[]): Product[] {
  const parts = query.replace(/^[^:]*:\s*/, '').split(/\s+(?:oppure|or)\s+/i);
  if (parts.length < 2) return [];
  const found = parts.map(part => products.filter(p => normalize(p.name) === normalize(part)));
  return found.every(f => f.length === 1) ? found.map(f => f[0]!) : [];
}
