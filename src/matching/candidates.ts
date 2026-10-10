import type { Client, Product } from '../domain/types.js';
import type { Candidate } from './types.js';

/** Explicit projections prevent contact details, notes and prices from leaking into matching. */
export function productCandidates(products: Product[], shippingProductId?: string): Candidate[] {
  return products.filter(p => p.netPrice > 0 && p.id !== shippingProductId)
    .map(({ id, code, name, description }) => ({ id, code, name, description }));
}
export function clientCandidates(clients: Client[]): Candidate[] {
  return clients.filter((c): c is Client & { id: string } => c.id !== undefined)
    .map(({ id, name, country, city, vatNumber }) => ({ id, name, country, city, ...(vatNumber ? { vatNumber } : {}) }));
}
