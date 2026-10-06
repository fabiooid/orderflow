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
  memory: z.object({ lastMessages: z.number().int().min(1).max(100) }).strict(),
}).strict().superRefine((config, ctx) => {
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
