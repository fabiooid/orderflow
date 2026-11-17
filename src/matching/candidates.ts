import type { Client, Product } from '../domain/types.js';
import type { Candidate } from './types.js';

/** Explicit projections prevent contact details, prices and street from leaking into matching. Notes and contact person carry everyday names; street is searched and shown on pick labels, not sent to the matcher. */
export function productCandidates(products: Product[], shippingProductId?: string): Candidate[] {
  return products.filter(p => p.netPrice > 0 && p.id !== shippingProductId)
    .map(({ id, code, name, description }) => ({ id, code, name, description }));
}
export function clientCandidates(clients: Client[]): Candidate[] {
  return clients.filter((c): c is Client & { id: string } => c.id !== undefined)
    .map(({ id, name, country, city, vatNumber, notes, contactPerson }) => {
      const aliases = [...new Set([notes, contactPerson].map(value => value?.trim().slice(0, 160) ?? '').filter(Boolean))];
      return { id, name, country, city, ...(vatNumber ? { vatNumber } : {}), ...(aliases.length ? { aliases } : {}) };
    });
}
