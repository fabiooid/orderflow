import { z } from 'zod';
import { clientSchema, draftSchema } from '../domain/types.js';

const clientFields: Record<string, string> = {
  name: 'The business name as given, without a leading role word such as customer or cliente.',
  country: 'ISO 3166 alpha-2 code such as IT, also when the address makes it clear (an Italian CAP with a province such as BG). null only when the address leaves it open.',
  street: 'Street and number of the billing address.',
  postalCode: 'Postal code (CAP).',
  province: 'Province code such as BG.',
  email: 'Ordinary email address.',
  certifiedEmail: 'PEC (posta elettronica certificata). Never put it in email or sdiCode.',
  sdiCode: 'Seven-character SDI recipient code.',
  vatNumber: 'VAT number (partita IVA) exactly as written.',
  taxCode: 'Tax code (codice fiscale).',
  contactPerson: 'Contact person at the business, only when the operator or the record gives one. Never invent a person.',
  notes: 'Only a note the operator explicitly asks for.',
};
const nullableClient = z.object(Object.fromEntries(Object.entries(clientSchema.omit({ id: true }).shape).map(([key, field]) => {
  let schema: z.ZodType = field;
  while (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) schema = schema.unwrap() as z.ZodType;
  const nullable = key === 'country' ? z.string().nullable() : schema.nullable();
  return [key, clientFields[key] ? nullable.describe(clientFields[key]) : nullable];
}))).strict();

export const identityStatusSchema = z.enum(['accepted', 'unconfirmed', 'ambiguous', 'unsupported', 'missing']);

export const orderDraftInput = z.object({
  clientQuery: z.string().describe('The customer name or VAT as the operator wrote it this request. Empty when unknown. Do not copy a cancelled request. Letterhead is not a customer. A unique search hit is not a lock.'),
  clientId: z.string().min(1).nullable().describe('Always null for a new lock. Keep only an id already on the open draft after a pick or exact typed name. A search result, alias, or yes-prepare-this-file is not an id.'),
  newClient: nullableClient.nullable().describe('Only when the operator says the customer is new or types billing details themselves. Attached names go in clientQuery.'),
  manualVatCheck: z.object({ country: z.string().regex(/^[A-Z]{2}$/), vatNumber: z.string().min(1), status: z.enum(['valid', 'invalid']) }).strict().nullable()
    .describe('Only after the operator explicitly confirms a completed VIES check. Never inferred.'),
  lines: z.array(z.object({
    ref: z.string().min(1).max(64).nullable().optional().describe('Stable line id from the open draft (L1, L2, …). Null to add a line. Send op=delete with a ref to remove one. Omitted lines are kept.'),
    op: z.enum(['add', 'edit', 'replace', 'delete']).nullable().optional().describe('add/edit/replace/delete against ref. Null with no refs replaces the whole list only when the rows actually changed.'),
    query: z.string().min(1).describe("The operator's product wording this request, including printed codes they wrote. Do not invent or append a catalogue code they did not write. Tester marks keep the printed sale code and set tester true."),
    productId: z.string().min(1).nullable().describe('A proposal only. The application accepts a unique supported SKU, unique tester, or exact catalogue name typed this request; it does not lock a fuzzy singleton or a code only you added. Never put a sale id on a tester line.'),
    quantity: z.number().positive().nullable().describe('Count of items, or the tester count on a tester line. A size is not a quantity. null when unknown.'),
    tester: z.boolean().nullable().describe('True only for a requested tester/sample line. A sale quantity and a tester mark are two lines.'),
    netPrice: z.number().nonnegative().nullable().describe('Net unit the operator stated. null: catalogue prices. Never a price read from a file.'),
    documentPrice: z.object({ amount: z.number().nonnegative(), basis: z.enum(['net', 'gross', 'unclear']), decision: z.enum(['pending', 'catalogue', 'document']) }).strict().nullable().default(null)
      .describe('A price printed in a document, pending until the operator answers. Null when none is pending.'),
  }).strict()).describe('Changes to lines. Empty keeps the open draft, including attachment rows already merged. A new request starts empty. Do not copy cancelled orders.'),
  shippingPrice: z.number().nonnegative().nullable().describe('Delivery charge, net. 0 when they say there is no charge this request. null when they have not stated it; the application keeps an explicit 0 already on this request and applies a no-charge phrase even if this field is omitted. Do not copy a cancelled request. A later amount on this request replaces an earlier 0.'),
  discountPercent: z.number().min(0).max(100).describe('Order discount the operator states, otherwise 0.'),
  discountShipping: z.boolean().nullable().describe('Whether the discount also applies to delivery, only when the operator says so.'),
  delivery: z.object({ country: z.string().nullable(), address: z.string().min(1) }).strict().nullable()
    .describe("Only when the operator asks to ship somewhere other than the customer's own address."),
  notes: z.string().describe("Printed on the order: only a note the operator asked to write. Empty when they did not. Do not summarise an attached message. Same language as the operator; do not translate catalogue names."),
  priceTier: z.string().regex(/^[a-z0-9-]+$/).nullable().describe('Always null: named price lists are not connected.'),
}).strict();

export const customerDraftInput = z.object({
  newClient: nullableClient.describe('The new customer. Only the name is required to create it; an order later also needs the billing address.'),
});

export const draftOutput = z.object({
  status: z.enum(['ready', 'needs', 'existing', 'blocked', 'invalid']),
  revision: z.number().int().nonnegative().optional(),
  customer: z.object({
    status: identityStatusSchema,
    query: z.string().optional(),
    name: z.string().optional(),
    city: z.string().optional(),
    vatNumber: z.string().optional(),
    candidates: z.array(z.string()).optional(),
    action: z.string().optional(),
  }).optional(),
  lines: z.array(z.object({
    ref: z.string(),
    query: z.string(),
    quantity: z.number().optional(),
    tester: z.literal(true).optional(),
    status: identityStatusSchema,
    candidates: z.array(z.string()).optional(),
    action: z.string().optional(),
  })).optional(),
  shipping: z.object({
    status: z.enum(['unknown', 'set']),
    amount: z.number().nonnegative().optional(),
    action: z.string().optional(),
  }).optional(),
  issues: z.array(z.object({ field: z.string(), problem: z.string(), candidates: z.array(z.string()).optional() })).optional(),
  note: z.string(),
});

const strip = (v: unknown): unknown => Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, strip(x)])) : v;
const iso = (country: unknown) => typeof country === 'string' && /^[A-Z]{2}$/.test(country.trim().toUpperCase()) ? country.trim().toUpperCase() : null;
const withIsoCountry = (value: Record<string, unknown> | null) => value && { ...value, country: iso(value.country) };

export function parseDraft(value: unknown) {
  const parsed = orderDraftInput.parse(value);
  const lines = parsed.lines.map(({ op: _op, ...line }) => line);
  return draftSchema.parse(strip({ ...parsed, lines, newClient: withIsoCountry(parsed.newClient), delivery: withIsoCountry(parsed.delivery) }));
}

/** Line edits including op/ref, used by the canonical merge. */
export function parseLinePatches(value: unknown) {
  return orderDraftInput.parse(value).lines.map(line => strip(line) as { ref?: string; op?: 'add' | 'edit' | 'replace' | 'delete'; query: string; productId?: string; quantity?: number; tester?: boolean; netPrice?: number });
}

/** A customer request is a draft with only its new customer. */
export function parseCustomer(value: unknown) {
  return draftSchema.parse(strip({ newClient: withIsoCountry(customerDraftInput.parse(value).newClient) }));
}
