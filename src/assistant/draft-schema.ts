import { z } from 'zod';
import { clientSchema, draftSchema } from '../domain/types.js';

/**
 * The order and customer APIs as the agent sees them. The business rules for each field live in its description, so
 * the schema tells the agent what is needed; the application validates every call and reports what is still missing.
 */
const clientFields: Record<string, string> = {
  name: 'Business name exactly as given, including words such as "Cliente".',
  country: 'ISO 3166 alpha-2 code such as IT, also when the address makes it clear (an Italian CAP with a province such as BG). null only when the address leaves it open.',
  street: 'Street and number of the billing address.',
  postalCode: 'Postal code (CAP).',
  province: 'Province code such as BG.',
  email: 'Ordinary email address.',
  certifiedEmail: 'PEC (posta elettronica certificata). Never put it in email or sdiCode.',
  sdiCode: 'Seven-character SDI recipient code.',
  vatNumber: 'VAT number (partita IVA) exactly as written.',
  taxCode: 'Tax code (codice fiscale).',
  notes: 'Only a note the operator explicitly asks for.',
};
// OpenAI strict structured outputs require explicit nulls for unknown fields.
const nullableClient = z.object(Object.fromEntries(Object.entries(clientSchema.omit({ id: true }).shape).map(([key, field]) => {
  let schema: z.ZodType = field;
  while (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) schema = schema.unwrap() as z.ZodType;
  // Countries are checked after parsing: one blank or unknown country must not reject the whole draft.
  const nullable = key === 'country' ? z.string().nullable() : schema.nullable();
  return [key, clientFields[key] ? nullable.describe(clientFields[key]) : nullable];
}))).strict();

export const orderDraftInput = z.object({
  clientQuery: z.string().describe('The customer name or VAT number the operator gave, as written. When the operator names the customer, that name wins over any company named in attached content. Empty when no customer is known yet.'),
  clientId: z.string().min(1).nullable().describe('Keep the clientId already in the open draft. Otherwise null: the application resolves clientQuery against current records.'),
  newClient: nullableClient.nullable().describe('Only when the operator says the customer is new or types its billing details themselves. A customer named, signed or printed in an attached email or document only identifies it: put its name in clientQuery and leave this null.'),
  manualVatCheck: z.object({ country: z.string().regex(/^[A-Z]{2}$/), vatNumber: z.string().min(1), status: z.enum(['valid', 'invalid']) }).strict().nullable()
    .describe('Only after the operator explicitly confirms a completed VIES check and its result, bound to that exact country and VAT number. Never inferred from a name, number format or location.'),
  lines: z.array(z.object({
    query: z.string().min(1).describe("The product the operator means, without quantity or price, keeping every size, scent, tester or code they give. Operators use short names, synonyms, plurals, typos and other languages: when their words share none with the catalogue, write it in the catalogue's terms as you understand it (\"saponi\" to \"hand wash\"). The application checks it against their message and asks when it is unsure."),
    productId: z.string().min(1).nullable().describe('Keep the productId already in the open draft, or copy the id from an order-form [productId …] marker. Otherwise null: the application resolves query against the catalogue and offers choices when several fit.'),
    quantity: z.number().positive().nullable().describe('Count of items ("5 x", "5 pezzi"). A size or volume such as "5 litri" is part of the product, not the quantity. null when no count is written.'),
    netPrice: z.number().nonnegative().nullable().describe('Net unit price the operator states for this order, including later corrections. null otherwise: catalogue prices apply. Never a price read from a document, never learned for future orders.'),
    documentPrice: z.object({ amount: z.number().nonnegative(), basis: z.enum(['net', 'gross', 'unclear']), decision: z.enum(['pending', 'catalogue', 'document']) }).strict().nullable().default(null)
      .describe('A price printed or handwritten in a document, kept as evidence with its basis and decision pending. Set catalogue or document only after the operator answers that price question; document needs an explicitly confirmed net amount. Reset to pending when the amount or product changes.'),
  }).strict()).describe('Every product line of the order, kept from the open draft unless the operator changes it.'),
  shippingPrice: z.number().nonnegative().nullable().describe('Delivery charge, net. null unless the operator states or confirms it; 0 when they say there is no charge.'),
  discountPercent: z.number().min(0).max(100).describe('Order discount the operator states, otherwise 0.'),
  discountShipping: z.boolean().nullable().describe('Whether the discount also applies to delivery, only when the operator says so.'),
  delivery: z.object({ country: z.string().nullable(), address: z.string().min(1) }).strict().nullable()
    .describe("Only when the operator asks to ship somewhere other than the customer's own address. A signature or letterhead address is never a delivery address."),
  notes: z.string().describe('Printed on the order: delivery or handling instructions from the operator or the customer\'s message (such as express delivery or a deadline), or a note the operator asks for. The operator sees it in the draft. Never prices, VAT codes, discounts or your own remarks.'),
  priceTier: z.string().regex(/^[a-z0-9-]+$/).nullable().describe('Always null: named price lists are not connected. Ask for explicit unit prices instead.'),
}).strict();

export const customerDraftInput = z.object({
  newClient: nullableClient.describe('The new customer. Only the name is required to create it; an order for it later also needs the full billing address. Keep every detail already in the open draft unless corrected.'),
});

// Model output uses null for unknown fields; drafts leave them out.
const strip = (v: unknown): unknown => Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, strip(x)])) : v;
// A country that is not an ISO code (often "" for an address without one) is unknown, not invalid.
const iso = (country: unknown) => typeof country === 'string' && /^[A-Z]{2}$/.test(country.trim().toUpperCase()) ? country.trim().toUpperCase() : null;
const withIsoCountry = (value: Record<string, unknown> | null) => value && { ...value, country: iso(value.country) };

export function parseDraft(value: unknown) {
  const parsed = orderDraftInput.parse(value);
  return draftSchema.parse(strip({ ...parsed, newClient: withIsoCountry(parsed.newClient), delivery: withIsoCountry(parsed.delivery) }));
}

/** A customer request is a draft with only its new customer. */
export function parseCustomer(value: unknown) {
  return draftSchema.parse(strip({ newClient: withIsoCountry(customerDraftInput.parse(value).newClient) }));
}
