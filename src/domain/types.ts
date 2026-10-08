import { z } from 'zod';

export const clientSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().min(1),
  country: z.string().regex(/^[A-Z]{2}$/),
  street: z.string().min(1),
  city: z.string().min(1),
  postalCode: z.string().min(1),
  province: z.string().optional(),
  email: z.email().optional(),
  phone: z.string().min(1).optional(),
  vatNumber: z.string().min(1).optional(),
  taxCode: z.string().min(1).optional(),
  sdiCode: z.string().regex(/^[A-Z0-9]{7}$/).optional(),
  notes: z.string().default(''),
}).strict();
export type Client = z.infer<typeof clientSchema>;

export const productSchema = z.object({
  id: z.number().int().positive(),
  code: z.string(),
  name: z.string().min(1),
  description: z.string().default(''),
  netPrice: z.number().finite().min(0),
});
export type Product = z.infer<typeof productSchema>;

export const draftSchema = z.object({
  manualVatCheck: z.object({
    country: z.string().regex(/^[A-Z]{2}$/),
    vatNumber: z.string().min(1),
    status: z.enum(['valid', 'invalid']),
  }).strict().optional(),
  clientQuery: z.string().default(''),
  clientId: z.number().int().positive().optional(),
  newClient: clientSchema.omit({ id: true }).partial().optional(),
  lines: z.array(z.object({
    query: z.string().min(1),
    productId: z.number().int().positive().optional(),
    quantity: z.number().finite().positive().max(100000).optional(),
    netPrice: z.number().finite().min(0).max(1000000).optional(),
    documentPrice: z.object({
      amount: z.number().finite().min(0).max(1000000),
      basis: z.enum(['net', 'gross', 'unclear']),
      decision: z.enum(['pending', 'catalogue', 'document']),
    }).strict().optional(),
  }).strict()).max(100).default([]),
  shippingPrice: z.number().finite().min(0).max(1000000).optional(),
  discountPercent: z.number().min(0).max(100).default(0),
  discountShipping: z.boolean().optional(),
  delivery: z.object({
    country: z.string().regex(/^[A-Z]{2}$/),
    address: z.string().min(1),
  }).strict().optional(),
  notes: z.string().max(4000).default(''),
  /** Legacy selection: only 'standard' is supported; other values require clarification. */
  priceTier: z.string().regex(/^[a-z0-9-]+$/).optional(),
}).strict().refine(d => !(d.clientId && d.newClient), { message: 'Choose an existing or a new client, not both' });
export type OrderDraft = z.infer<typeof draftSchema>;

export const orderLineSchema = z.object({
  productId: z.number().int().positive(),
  code: z.string(),
  name: z.string().min(1),
  quantity: z.number().finite().positive(),
  netPrice: z.number().finite().min(0),
  discountPercent: z.number().min(0).max(100),
  vatId: z.number().int().nonnegative(),
  vatRate: z.number().min(0).max(100),
  nature: z.string().optional(),
  shipping: z.boolean(),
}).strict();
export const preparedOrderSchema = z.object({
  type: z.literal('order'),
  policyVersion: z.string(),
  currency: z.literal('EUR'),
  client: clientSchema,
  lines: z.array(orderLineSchema).min(1),
  delivery: z.object({ country: z.string(), address: z.string() }).strict(),
  notes: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paymentMethodId: z.number().int().positive().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Retained for reading historical prepared orders. New orders use API prices or explicit overrides. */
  priceTier: z.string().optional(),
}).strict();
export type PreparedOrder = z.infer<typeof preparedOrderSchema>;
export type OrderLine = z.infer<typeof orderLineSchema>;
export const totalsSchema = z.object({ net: z.number(), vat: z.number(), gross: z.number() });
export type Totals = z.infer<typeof totalsSchema>;
export type SavedOrder = { id: number; number: string; url?: string };
/** A client's earlier order, read only to point out differences. */
export type ClientOrder = { id: number; number: string; date: string; lines: { productId?: number; code: string; name: string; quantity: number; netPrice: number; discountPercent: number }[] };
export type VatValidation = 'valid' | 'invalid' | 'unavailable' | 'unchecked';
export type Issue = { matchingStatus?: 'ambiguous' | 'no-match' | 'unavailable'; field: string; message: string; candidates?: { id: number; label: string }[]; priceComparison?: { document: number; catalogue: number; basis: 'net' | 'gross' | 'unclear' } };
