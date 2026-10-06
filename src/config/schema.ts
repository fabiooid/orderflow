import { z } from 'zod';

const country = z.string().regex(/^[A-Z]{2}$/);
const positiveId = z.number().int().positive();
const vatRuleSchema = z.object({
  id: z.string().min(1),
  priority: z.number().int(),
  billingCountries: z.array(country).min(1).optional(),
  deliveryCountries: z.array(country).min(1).optional(),
  vatId: z.number().int().nonnegative(),
  rate: z.number().min(0).max(100),
  nature: z.string().regex(/^N\d(\.\d)?$/).optional(),
  requireValidVat: z.boolean().default(false),
}).strict().refine(r => r.rate !== 0 || Boolean(r.nature), {
  message: 'Zero-rate rules require an explicit nature code',
});

const slug = z.string().regex(/^[a-z0-9-]+$/);

/** A printed order form customers fill in by hand, mapped row by row to catalogue products. */
export const orderFormSchema = z.object({
  schemaVersion: z.literal(1),
  id: slug,
  name: z.string().min(1),
  /** Prices printed on this form are this tier's prices. */
  priceTier: slug.optional(),
  /** Printed column headings, used to tell similar forms apart. */
  headings: z.array(z.string()).default([]),
  rows: z.array(z.object({
    /** Code printed on the row, such as an SKU; empty when the row has none. */
    code: z.string(),
    label: z.string().min(1),
    productId: positiveId,
    /** Product added by a mark in the tester column. */
    testerProductId: positiveId.optional(),
    netPrice: z.number().min(0).optional(),
  }).strict()).min(1),
}).strict();
export type OrderForm = z.infer<typeof orderFormSchema>;

export const configSchema = z.object({
  schemaVersion: z.literal(1),
  deploymentId: z.string().regex(/^[a-z0-9-]+$/),
  policyVersion: z.string().min(1),
  companyId: positiveId,
  locale: z.enum(['it', 'en']),
  currency: z.literal('EUR'),
  priceBasis: z.literal('net'),
  telegram: z.object({
    groupId: z.string().regex(/^-\d+$/),
    command: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    access: z.literal('all-group-members'),
    respondToAllMessages: z.boolean().default(false),
  }).strict(),
  orderSavingEnabled: z.boolean().default(false),
  shipping: z.object({ productId: positiveId, discountByDefault: z.boolean() }).strict(),
  clients: z.object({
    requiredFields: z.array(z.enum(['email', 'phone', 'vatNumber', 'taxCode'])),
    sdiCountries: z.array(country),
    shippingNotesLabel: z.string().min(1).max(80),
  }).strict(),
  payments: z.object({
    methodId: positiveId.optional(),
    dueDays: z.number().int().min(0).max(365).default(0),
  }).strict(),
  vatRules: z.array(vatRuleSchema).min(1),
  model: z.string().regex(/^[^/\s]+\/[^\s]+$/),
  /** Speech-to-text for Telegram voice notes; omit to answer voice notes with "not enabled". */
  transcription: z.object({ model: z.string().regex(/^openai\/[^\s]+$/, 'Only OpenAI transcription models are supported') }).strict().optional(),
  memory: z.object({ lastMessages: z.number().int().min(1).max(100) }).strict(),
  /** Named price lists; clients listed here get the tier's prices from its order forms. */
  priceTiers: z.array(z.object({ id: slug, name: z.string().min(1), clientIds: z.array(positiveId) }).strict()).default([]),
  /** In the file, entries may be paths to form JSON files; loadConfig reads them. */
  orderForms: z.array(orderFormSchema).default([]),
}).strict().superRefine((config, ctx) => {
  const tiers = new Set(config.priceTiers.map(t => t.id));
  if (tiers.size !== config.priceTiers.length) ctx.addIssue({ code: 'custom', path: ['priceTiers'], message: 'Duplicate price tier ID' });
  const clients = config.priceTiers.flatMap(t => t.clientIds);
  if (new Set(clients).size !== clients.length) ctx.addIssue({ code: 'custom', path: ['priceTiers'], message: 'A client can belong to one price tier only' });
  const forms = new Set<string>();
  for (const [i, form] of config.orderForms.entries()) {
    if (forms.has(form.id)) ctx.addIssue({ code: 'custom', path: ['orderForms', i], message: 'Duplicate order form ID' });
    forms.add(form.id);
    if (form.priceTier && !tiers.has(form.priceTier)) ctx.addIssue({ code: 'custom', path: ['orderForms', i, 'priceTier'], message: 'Unknown price tier' });
    if (form.priceTier && form.rows.some(r => r.netPrice === undefined)) ctx.addIssue({ code: 'custom', path: ['orderForms', i], message: 'A price-tier form needs a price on every row' });
  }
  const ids = new Set<string>();
  const intersects = (a?: string[], b?: string[]) => !a || !b || a.some(c => b.includes(c));
  for (const [i, rule] of config.vatRules.entries()) {
    if (ids.has(rule.id)) ctx.addIssue({ code: 'custom', path: ['vatRules', i], message: 'Duplicate VAT rule ID' });
    ids.add(rule.id);
    for (const other of config.vatRules.slice(0, i)) {
      if (rule.priority === other.priority && intersects(rule.billingCountries, other.billingCountries) && intersects(rule.deliveryCountries, other.deliveryCountries)) {
        ctx.addIssue({ code: 'custom', path: ['vatRules', i], message: 'Overlapping VAT rules need distinct priorities' });
      }
    }
  }
});

export type AppConfig = z.infer<typeof configSchema>;

/** Picks the user-facing string for the configured locale. */
export function translate(config: Pick<AppConfig, 'locale'>, it: string, en: string) { return config.locale === 'it' ? it : en; }

/** Tier of a client, if any. */
export function clientTier(config: Pick<AppConfig, 'priceTiers'>, clientId?: number) {
  return clientId === undefined ? undefined : config.priceTiers.find(t => t.clientIds.includes(clientId));
}

/** Net prices of a tier, by product, from the order forms printed for it. */
export function tierPrices(config: Pick<AppConfig, 'orderForms'>, tierId: string) {
  const prices = new Map<number, number>();
  for (const form of config.orderForms) if (form.priceTier === tierId) for (const row of form.rows) if (row.netPrice !== undefined) prices.set(row.productId, row.netPrice);
  return prices;
}
