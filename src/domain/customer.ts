import type { AppConfig } from '../config/schema.js';
import { newCustomerSchema, type NewCustomer, type OrderDraft } from './types.js';

/** Customer fields this deployment requires, for new customers and for the customer on an order alike. */
export function missingCustomerFields(client: Partial<NewCustomer>, config: AppConfig): string[] {
  const missing: string[] = config.clients.requiredFields.filter(field => !client[field]);
  const italy = config.tax?.italy;
  if (client.country && italy?.sdiCountries.includes(client.country) && !client.sdiCode) missing.push('sdiCode');
  if (client.country && italy?.pecCountries.includes(client.country) && !client.certifiedEmail) missing.push('certifiedEmail');
  return missing;
}

/** Only the name, plus whatever this deployment demands, blocks creation; the preview suggests the rest. */
export function customerDetails(draft: OrderDraft, config: AppConfig): { client: NewCustomer; missing?: never } | { client?: never; missing: string[] } {
  const parsed = newCustomerSchema.safeParse(draft.newClient);
  if (!parsed.success) return { missing: ['name'] };
  const missing = missingCustomerFields(parsed.data, config);
  return missing.length ? { missing } : { client: parsed.data };
}
