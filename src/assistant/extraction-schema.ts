import { z } from 'zod';
import { clientSchema, draftSchema } from '../domain/types.js';

// OpenAI strict structured outputs require explicit nulls for unknown fields.
const nullableClient = z.object(Object.fromEntries(Object.entries(clientSchema.omit({ id: true }).shape).map(([key, field]) => {
  let schema: z.ZodType = field;
  while (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) schema = schema.unwrap() as z.ZodType;
  return [key, schema.nullable()];
}))).strict();
export const extractionSchema = z.object({
  clientQuery: z.string(), clientId: z.number().int().positive().nullable(),
  newClient: nullableClient.nullable(),
  manualVatCheck: z.object({ country: z.string().regex(/^[A-Z]{2}$/), vatNumber: z.string().min(1), status: z.enum(['valid', 'invalid']) }).strict().nullable(),
  lines: z.array(z.object({ query: z.string().min(1), productId: z.number().int().positive().nullable(), quantity: z.number().positive().nullable(), netPrice: z.number().nonnegative().nullable() }).strict()),
  shippingPrice: z.number().nonnegative().nullable(), discountPercent: z.number().min(0).max(100), discountShipping: z.boolean().nullable(),
  delivery: z.object({ country: z.string().regex(/^[A-Z]{2}$/), address: z.string().min(1) }).strict().nullable(), notes: z.string(),
}).strict();
export function parseExtraction(value: unknown) {
  const strip = (v: unknown): unknown => Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, strip(x)])) : v;
  return draftSchema.parse(strip(extractionSchema.parse(value)));
}
