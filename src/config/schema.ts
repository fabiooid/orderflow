import { z } from 'zod';

const telegramChannelSchema = z.object({
  provider: z.literal('telegram'),
  groupId: z.string().regex(/^-\d+$/),
  access: z.literal('all-group-members'),
  respondToAllMessages: z.boolean().default(false),
}).strict();

const asOpaque = (value: unknown) => typeof value === 'string' && value.length ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;

/** Accepts older top-level keys by folding them into channel, invoicing, and the optional Italy tax section. */
function liftLegacy(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  if (!record.channel && record.telegram && typeof record.telegram === 'object') {
    record.channel = { provider: 'telegram', ...(record.telegram as object) };
    delete record.telegram;
  }
  if (!record.invoicing && typeof record.companyId === 'number') {
    record.invoicing = { provider: 'fatture-in-cloud', companyId: record.companyId };
    delete record.companyId;
  } else if (record.invoicing && typeof record.invoicing === 'object' && (record.invoicing as { companyId?: number }).companyId === record.companyId) {
    delete record.companyId;
  }
  const invoicing = record.invoicing && typeof record.invoicing === 'object' ? { ...(record.invoicing as Record<string, unknown>) } : undefined;
  const shipping = record.shipping && typeof record.shipping === 'object' ? { ...(record.shipping as Record<string, unknown>) } : undefined;
  if (invoicing && shipping && invoicing.shippingProductId === undefined) {
    const shippingProductId = asOpaque(shipping.productId);
    if (shippingProductId) {
      invoicing.shippingProductId = shippingProductId;
      delete shipping.productId;
      record.shipping = shipping;
      record.invoicing = invoicing;
    }
  }
  if (invoicing && Array.isArray(record.vatRules) && invoicing.vat === undefined) {
    const vat = record.vatRules.flatMap(rule => {
      if (!rule || typeof rule !== 'object' || !('vatId' in rule)) return [];
      const item = rule as { id?: unknown; vatId?: unknown; nature?: unknown };
      return typeof item.vatId === 'number' && typeof item.id === 'string' ? [{ ruleId: item.id, vatId: item.vatId, ...(typeof item.nature === 'string' ? { nature: item.nature } : {}) }] : [];
    });
    if (vat.length) {
      invoicing.vat = vat;
      record.vatRules = record.vatRules.map(rule => {
        if (!rule || typeof rule !== 'object') return rule;
        const { vatId: _vatId, nature: _nature, ...rest } = rule as Record<string, unknown>;
        return rest;
      });
      record.invoicing = invoicing;
    }
  }
  const clients = record.clients && typeof record.clients === 'object' ? { ...(record.clients as Record<string, unknown>) } : undefined;
  if (clients && (clients.sdiCountries || clients.pecCountries)) {
    const tax = record.tax && typeof record.tax === 'object' ? { ...(record.tax as Record<string, unknown>) } : {};
    const italy = tax.italy && typeof tax.italy === 'object' ? { ...(tax.italy as Record<string, unknown>) } : {};
    if (italy.sdiCountries === undefined && clients.sdiCountries) italy.sdiCountries = clients.sdiCountries;
    if (italy.pecCountries === undefined && clients.pecCountries) italy.pecCountries = clients.pecCountries;
    delete clients.sdiCountries;
    delete clients.pecCountries;
    tax.italy = italy;
    record.tax = tax;
    record.clients = clients;
  }
  if (Array.isArray(record.priceTiers)) {
    record.priceTiers = record.priceTiers.map(tier => {
      if (!tier || typeof tier !== 'object' || !Array.isArray((tier as { clientIds?: unknown }).clientIds)) return tier;
      return { ...tier, clientIds: (tier as { clientIds: unknown[] }).clientIds.map(id => asOpaque(id) ?? id) };
    });
  }
  if (Array.isArray(record.orderForms)) {
    record.orderForms = record.orderForms.map(form => {
      if (!form || typeof form !== 'object' || !Array.isArray((form as { rows?: unknown }).rows)) return form;
      return { ...form, rows: (form as { rows: unknown[] }).rows.map(row => {
        if (!row || typeof row !== 'object' || !(row as { cells?: unknown }).cells || typeof (row as { cells?: unknown }).cells !== 'object') return row;
        const cells = Object.fromEntries(Object.entries((row as { cells: Record<string, unknown> }).cells).map(([key, cell]) => {
          if (!cell || typeof cell !== 'object') return [key, cell];
          const productId = asOpaque((cell as { productId?: unknown }).productId);
          return [key, productId ? { ...cell, productId } : cell];
        }));
        return { ...row, cells };
      }) };
    });
  }
  return record;
}

const country = z.string().regex(/^[A-Z]{2}$/);
const positiveId = z.number().int().positive();
/** Product, customer, and order ids. Adapters convert their own id types at the boundary. */
const opaqueId = z.string().min(1);
const natureCode = z.string().regex(/^N\d(\.\d)?$/);
const invoicingSchema = z.object({
  provider: z.literal('fatture-in-cloud'),
  companyId: positiveId,
  /** Name shown to operators. Defaults to the provider's own name. */
  label: z.string().min(1).max(80).default('Fatture in Cloud'),
  /** Catalogue product used as the delivery line. Opaque to the domain; this provider stores a numeric id. */
  shippingProductId: opaqueId,
  /** Fatture in Cloud VAT type for each generic VAT rule. */
  vat: z.array(z.object({
    ruleId: z.string().min(1),
    vatId: z.number().int().nonnegative(),
    nature: natureCode.optional(),
  }).strict()).min(1),
}).strict();
const vatRuleSchema = z.object({
  id: z.string().min(1),
  priority: z.number().int(),
  billingCountries: z.array(country).min(1).optional(),
  deliveryCountries: z.array(country).min(1).optional(),
  rate: z.number().min(0).max(100),
  requireValidVat: z.boolean().default(false),
}).strict();

const slug = z.string().regex(/^[a-z0-9-]+$/);

/**
 * A printed order form customers fill in by hand: printed rows crossed with the columns they write in.
 * Each cell names the product that writing in it orders, so the form's meaning lives in data, not code.
 */
export const orderFormSchema = z.object({
  schemaVersion: z.literal(1),
  id: slug,
  name: z.string().min(1),
  /** Prices in this form's cells are this tier's prices. */
  priceTier: slug.optional(),
  /** Printed column headings, used to tell similar forms apart. */
  headings: z.array(z.string()).default([]),
  /** Columns customers write in: a number of pieces, or a mark (such as an X) that orders one piece. */
  columns: z.array(z.object({ id: slug, heading: z.string().min(1), value: z.enum(['quantity', 'mark']) }).strict()).min(1),
  rows: z.array(z.object({
    /** Code printed on the row, such as an SKU; empty when the row has none. */
    code: z.string(),
    label: z.string().min(1),
    /** Column ID → product ordered by writing in that cell. A row may leave columns out. */
    cells: z.record(z.string(), z.object({ productId: opaqueId, netPrice: z.number().min(0).optional() }).strict()),
  }).strict()).min(1),
}).strict().superRefine((form, ctx) => {
  const columns = new Set(form.columns.map(c => c.id));
  form.rows.forEach((row, i) => {
    for (const id of Object.keys(row.cells)) if (!columns.has(id)) ctx.addIssue({ code: 'custom', path: ['rows', i, 'cells', id], message: 'Unknown column' });
  });
});
export type OrderForm = z.infer<typeof orderFormSchema>;

const configObject = z.object({
  schemaVersion: z.literal(1),
  deploymentId: z.string().regex(/^[a-z0-9-]+$/),
  policyVersion: z.string().min(1),
  locale: z.enum(['it', 'en']),
  currency: z.string().regex(/^[A-Z]{3}$/),
  priceBasis: z.literal('net'),
  /** Which conversation to join. Add a provider by extending this object. */
  channel: telegramChannelSchema,
  /** Which invoicing system stores orders. Add a provider by extending this object. */
  invoicing: invoicingSchema,
  orderSavingEnabled: z.boolean().default(false),
  /** Optional regional e-invoicing. Omitted means the deployment does not collect SDI or PEC. */
  tax: z.object({
    italy: z.object({
      sdiCountries: z.array(country).default([]),
      pecCountries: z.array(country).default([]),
    }).strict(),
  }).strict().optional(),
  shipping: z.object({ discountByDefault: z.boolean() }).strict(),
  clients: z.object({
    requiredFields: z.array(z.enum(['email', 'phone', 'vatNumber', 'taxCode'])),
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
  priceTiers: z.array(z.object({ id: slug, name: z.string().min(1), clientIds: z.array(opaqueId) }).strict()).default([]),
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
    const bindings = config.invoicing.vat.filter(item => item.ruleId === rule.id);
    if (bindings.length !== 1) ctx.addIssue({ code: 'custom', path: ['invoicing', 'vat'], message: 'Each VAT rule needs one provider VAT binding' });
    else if (rule.rate === 0 && !bindings[0]?.nature) ctx.addIssue({ code: 'custom', path: ['invoicing', 'vat'], message: 'Zero-rate rules require an explicit nature code' });
  }
});

export const configSchema = z.preprocess(liftLegacy, configObject);

export type AppConfig = z.infer<typeof configSchema>;

/** Tier of a client, if any. */
export function clientTier(config: Pick<AppConfig, 'priceTiers'>, clientId?: string) {
  return clientId === undefined ? undefined : config.priceTiers.find(t => t.clientIds.includes(clientId));
}

/** Net prices of a tier, by product, from the order forms printed for it. */
export function tierPrices(config: Pick<AppConfig, 'orderForms'>, tierId: string) {
  const prices = new Map<string, number>();
  for (const form of config.orderForms) if (form.priceTier === tierId) {
    for (const row of form.rows) for (const cell of Object.values(row.cells)) if (cell.netPrice !== undefined) prices.set(cell.productId, cell.netPrice);
  }
  return prices;
}
