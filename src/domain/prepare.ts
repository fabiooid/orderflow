import type { AppConfig } from '../config/schema.js';
import type { OrderConnector } from '../connector/contract.js';
import { clientSchema, draftSchema, preparedOrderSchema, type Client, type Issue, type OrderDraft, type OrderLine, type PreparedOrder, type Product, type VatValidation } from './types.js';
import { asksForTester, isTester, matchProducts, normalize, sameClient, searchCatalogue } from './matching.js';

export type Preparation = { ready: false; issues: Issue[]; draft: OrderDraft } | { ready: true; order: PreparedOrder };
export type ValidationLookup = (country: string, vatNumber: string) => Promise<VatValidation>;

export async function prepareOrder(input: OrderDraft, config: AppConfig, connector: OrderConnector, date: string, validateVat?: ValidationLookup): Promise<Preparation> {
  const draft = draftSchema.parse(input);
  const [products, clients] = await Promise.all([connector.listProducts(), connector.listClients()]);
  const issues: Issue[] = [];
  const query = normalize(draft.clientQuery);
  const matches = clients.filter(c => draft.clientId ? c.id === draft.clientId : query !== '' && (normalize(c.name) === query || normalize(c.vatNumber ?? '') === query));
  let client: Partial<Client> | undefined = draft.newClient ?? (matches.length === 1 ? matches[0] : undefined);
  if (draft.newClient) {
    const duplicates = clients.filter(c => sameClient(c, draft.newClient!));
    if (duplicates.length) {
      issues.push({ field: 'client', message: 'Possible existing client: choose the record before creating another', candidates: duplicates.filter(c => c.id).map(c => ({ id: c.id!, label: c.name })) });
      client = undefined;
    }
  } else if (!client) {
    issues.push({ field: 'client', message: 'Choose an existing client or supply complete new-client details', candidates: matches.filter(c => c.id).map(c => ({ id: c.id!, label: c.name })) });
  }
  if (client) {
    const valid = clientSchema.safeParse(client);
    if (!valid.success) issues.push({ field: 'client', message: 'Client billing details are incomplete or invalid' });
    for (const field of config.clients.requiredFields) if (!client[field]) issues.push({ field: `client.${field}`, message: `Missing required client field: ${field}` });
    if (config.clients.sdiCountries.includes(client.country ?? '') && !client.sdiCode) issues.push({ field: 'client.sdiCode', message: 'SDI code is required by this deployment' });
  }

  const shipping = products.find(p => p.id === config.shipping.productId);
  if (!shipping) throw new Error('Configured shipping product does not exist');
  if (draft.shippingPrice === undefined) issues.push({ field: 'shippingPrice', message: `Confirm delivery price; catalogue default is ${shipping.netPrice} ${config.currency} excluding VAT` });

  if (!draft.lines.length) issues.push({ field: 'lines', message: 'Add at least one product and quantity' });
  const catalogue = products.filter(p => p.id !== shipping.id);
  const selected: { product: Product; quantity: number; netPrice?: number }[] = [];
  for (const [index, line] of draft.lines.entries()) {
    const field = `lines.${index}`;
    if (line.quantity === undefined) {
      issues.push({ field: `${field}.quantity`, message: 'Specify the quantity' });
      continue;
    }
    const pick = line.productId === undefined ? undefined : products.find(p => p.id === line.productId);
    if (pick?.id === shipping.id) {
      issues.push({ field, message: 'Delivery belongs in shippingPrice, not merchandise lines' });
      continue;
    }
    const accepted = pick && (!isTester(pick) || asksForTester(line.query)) ? pick : undefined;
    const matches = accepted || line.productId !== undefined ? [] : matchProducts(line.query, catalogue);
    const chosen = accepted ?? (matches.length === 1 ? matches[0] : undefined);
    if (chosen) {
      selected.push({ product: chosen, quantity: line.quantity, netPrice: line.netPrice });
      continue;
    }
    const candidates = matches.length ? matches : searchCatalogue(line.query, catalogue);
    const message = matches.length ? 'Choose the exact product or variant' : candidates.length ? 'No exact product for this description; choose one of the related products' : 'No matching product; clarify the name and size';
    issues.push({ field, message, candidates: candidates.map(p => ({ id: p.id, label: p.name })) });
  }

  const delivery = draft.delivery ?? (client ? { country: client.country ?? '', address: [client.street, client.postalCode, client.city, client.country].join(', ') } : undefined);
  const rules = client && delivery ? config.vatRules.filter(r => (!r.billingCountries || r.billingCountries.includes(client.country ?? '')) && (!r.deliveryCountries || r.deliveryCountries.includes(delivery.country))).sort((a, b) => b.priority - a.priority) : [];
  const rule = rules[0];
  if (client && !rule) issues.push({ field: 'vat', message: 'No configured VAT rule matches this billing and delivery destination; review required' });
  if (rule?.requireValidVat && client) {
    const manual = draft.manualVatCheck;
    const confirmed = manual && manual.country === client.country && normalize(manual.vatNumber) === normalize(client.vatNumber ?? '');
    const status = confirmed ? manual.status : client.vatNumber && client.country && validateVat ? await validateVat(client.country, client.vatNumber) : 'unchecked';
    if (status !== 'valid') issues.push({ field: 'vat', message: `VAT validation is ${status}. Confirm a manual VIES check for ${client.country} ${client.vatNumber ?? "(missing VAT number)"}; N3.2 requires a valid result.` });
  }
  const shippingPrice = draft.shippingPrice;
  if (issues.length || !client || !delivery || !rule || shippingPrice === undefined) return { ready: false, issues, draft };

  const makeLine = (product: Product, quantity: number, isShipping: boolean, netPrice?: number): OrderLine => ({
    productId: product.id, code: product.code, name: product.name, quantity,
    netPrice: isShipping ? shippingPrice : netPrice ?? product.netPrice,
    discountPercent: !isShipping || (draft.discountShipping ?? config.shipping.discountByDefault) ? draft.discountPercent : 0,
    vatId: rule.vatId, vatRate: rule.rate, nature: rule.nature, shipping: isShipping,
  });
  const due = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(due.getTime()) || due.toISOString().slice(0, 10) !== date) throw new Error('Invalid order date');
  due.setUTCDate(due.getUTCDate() + config.payments.dueDays);
  const deliveryNote = draft.delivery ? `${config.clients.shippingNotesLabel}: ${draft.delivery.address}` : '';
  return { ready: true, order: preparedOrderSchema.parse({
    type: 'order', policyVersion: config.policyVersion, currency: config.currency, client,
    lines: [...selected.map(({ product, quantity, netPrice }) => makeLine(product, quantity, false, netPrice)), makeLine(shipping, 1, true)],
    delivery, notes: [draft.notes, deliveryNote].filter(Boolean).join('\n'), date,
    paymentMethodId: config.payments.methodId, dueDate: due.toISOString().slice(0, 10),
  }) };
}
