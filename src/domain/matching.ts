import type { Product } from './types.js';

/** Most choices shown to the operator for one question. */
export const MAX_CHOICES = 10;

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

/** "A oppure B" (or "A or B") naming catalogue products exactly, such as a doubtful value read from an order form; anything before a colon is a label. */
export function namedAlternatives(query: string, products: Product[]): Product[] {
  const parts = query.replace(/^[^:]*:\s*/, '').split(/\s+(?:oppure|or)\s+/i);
  if (parts.length < 2) return [];
  const found = parts.map(part => products.filter(p => normalize(p.name) === normalize(part)));
  return found.every(f => f.length === 1) ? found.map(f => f[0]!) : [];
}
