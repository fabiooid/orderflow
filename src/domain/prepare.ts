import type { AppConfig } from '../config/schema.js';
import type { OrderConnector } from '../connector/contract.js';
import { clientSchema, draftSchema, preparedOrderSchema, type Client, type Issue, type OrderDraft, type OrderLine, type PreparedOrder, type Product, type VatValidation } from './types.js';
import { missingCustomerFields } from './customer.js';
import { asksForTester, isTester, matchProducts, namedAlternatives, normalize, sameClient, searchCatalogue } from './matching.js';

/** `draft` is the draft as preparation read it, for example without a delivery address equal to the billing one. */
export type Preparation = { ready: false; issues: Issue[]; draft: OrderDraft; clientId?: string } | { ready: true; order: PreparedOrder; draft: OrderDraft };
export type ValidationLookup = (country: string, vatNumber: string) => Promise<VatValidation>;
const toCandidates = (clients: Client[]) => clients.filter(c => c.id).map(c => ({ id: c.id!, label: c.name }));

export async function prepareOrder(input: OrderDraft, config: AppConfig, connector: Pick<OrderConnector, 'listProducts' | 'listClients'>, date: string, validateVat?: ValidationLookup): Promise<Preparation> {
  const draft = draftSchema.parse(input);
  const [products, clients] = await Promise.all([connector.listProducts(), connector.listClients()]);
  const issues: Issue[] = [];
  const query = normalize(draft.clientQuery);
  const matches = clients.filter(c => draft.clientId ? c.id === draft.clientId : query !== '' && (normalize(c.name) === query || normalize(c.vatNumber ?? '') === query));
  let client: Partial<Client> | undefined = draft.newClient ?? (matches.length === 1 ? matches[0] : undefined);
  if (draft.newClient) {
    const duplicates = clients.filter(c => sameClient(c, draft.newClient!));
    if (duplicates.length) {
      issues.push({ field: 'client', message: 'Possible existing client: choose the record before creating another', candidates: toCandidates(duplicates) });
      client = undefined;
    }
  } else if (!client) {
    issues.push({ field: 'client', message: 'Choose an existing client or supply complete new-client details', candidates: toCandidates(matches) });
  }
  if (client) {
    const valid = clientSchema.safeParse(client);
    if (!valid.success) issues.push({ field: 'client', message: 'Client billing details are incomplete or invalid' });
    for (const field of missingCustomerFields(client, config)) issues.push({ field: `client.${field}`, message: `Missing required customer field: ${field}` });
  }

  const shipping = products.find(p => p.id === config.invoicing.shippingProductId);
  if (!shipping) throw new Error('Configured shipping product does not exist');

  if (!draft.lines.length) issues.push({ field: 'lines', message: 'Add at least one product and quantity' });
  const catalogue = products.filter(p => p.id !== shipping.id);
  const selected: { product: Product; quantity: number; netPrice?: number; index: number }[] = [];
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
    const accepted = pick && (!isTester(pick) || asksForTester(line.query) || normalize(pick.code) === normalize(line.query) || normalize(pick.name) === normalize(line.query)) ? pick : undefined;
    const matches = accepted || line.productId !== undefined ? [] : matchProducts(line.query, catalogue);
    const chosen = accepted ?? (matches.length === 1 ? matches[0] : undefined);
    if (chosen) {
      const documentPrice = line.documentPrice;
      let netPrice = line.netPrice;
      if (documentPrice) {
        const same = documentPrice.basis === 'net' && documentPrice.amount === chosen.netPrice;
        if (documentPrice.decision === 'catalogue' || (documentPrice.decision === 'pending' && same)) {
          netPrice = undefined;
        } else if (documentPrice.decision === 'document' && documentPrice.basis === 'net') {
          netPrice = documentPrice.amount;
        } else {
          issues.push({ field: `${field}.documentPrice`, message: `Document: ${documentPrice.amount} ${config.currency} (${documentPrice.basis}); catalogue: ${chosen.netPrice} ${config.currency} net. Choose catalogue prices or explicitly confirm a net document price.`, priceComparison: { document: documentPrice.amount, catalogue: chosen.netPrice, basis: documentPrice.basis } });
        }
      }
      selected.push({ product: chosen, quantity: line.quantity, netPrice, index });
      continue;
    }
    const named = matches.length ? [] : namedAlternatives(line.query, catalogue);
    const candidates = matches.length ? matches : named.length ? named : searchCatalogue(line.query, catalogue);
    const message = matches.length || named.length ? 'Choose the exact product or variant' : candidates.length ? 'No exact product for this description; choose one of the related products' : 'No matching product; clarify the name and size';
    issues.push({ field, message, candidates: candidates.map(p => ({ id: p.id, label: p.name })) });
  }

  // Legacy template prices are not a live price list. Always use fresh API prices
  // unless this order explicitly supplies a unit price.
  if (draft.priceTier && draft.priceTier !== 'standard') issues.push({ field: 'priceTier', message: 'Automatic price lists are not supported. Confirm standard API prices or supply explicit unit prices and clear the price-list selection.' });

  const delivery = draft.delivery ?? (client ? { country: client.country ?? '', address: [client.street, client.postalCode, client.city, client.country].join(', ') } : undefined);
  const unknownCountry = draft.delivery !== undefined && !draft.delivery.country;
  if (unknownCountry) issues.push({ field: 'delivery.country', message: 'The delivery address has no country' });
  const rules = client && delivery && !unknownCountry ? config.vatRules.filter(r => (!r.billingCountries || r.billingCountries.includes(client.country ?? '')) && (!r.deliveryCountries || r.deliveryCountries.includes(delivery.country ?? ''))).sort((a, b) => b.priority - a.priority) : [];
  const rule = rules[0];
  if (client && !rule && !unknownCountry) issues.push({ field: 'vat', message: 'No configured VAT rule matches this billing and delivery destination; review required' });
  if (rule?.requireValidVat && client) {
    const manual = draft.manualVatCheck;
    const confirmed = manual && manual.country === client.country && normalize(manual.vatNumber) === normalize(client.vatNumber ?? '');
    const status = confirmed ? manual.status : client.vatNumber && client.country && validateVat ? await validateVat(client.country, client.vatNumber) : 'unchecked';
    if (status !== 'valid') issues.push({ field: 'vat', message: `VAT validation is ${status}. Confirm a manual VIES check for ${client.country} ${client.vatNumber ?? "(missing VAT number)"}; N3.2 requires a valid result.` });
  }
  const shippingPrice = draft.shippingPrice;
  // Delivery is just another line: ask about it only once everything else is settled, never as an opening gate.
  if (!issues.length && shippingPrice === undefined) issues.push({ field: 'shippingPrice', message: `Confirm the delivery charge (catalogue default ${shipping.netPrice} ${config.currency} excluding VAT) or remove it`, defaultPrice: shipping.netPrice });
  // Report the existing customer already identified, so questions can show who the order is for.
  const existing = !draft.newClient && matches.length === 1 ? matches[0]!.id : undefined;
  const binding = rule ? config.invoicing.vat.find(item => item.ruleId === rule.id) : undefined;
  if (rule && !binding) issues.push({ field: 'vat', message: 'No provider VAT binding matches this rule; review required' });
  if (issues.length || !client || !delivery || !rule || !binding || shippingPrice === undefined) return { ready: false, issues, draft, ...(existing ? { clientId: existing } : {}) };

  const makeLine = (product: Product, quantity: number, isShipping: boolean, netPrice?: number): OrderLine => ({
    productId: product.id, code: product.code, name: product.name, quantity,
    netPrice: isShipping ? shippingPrice : netPrice ?? product.netPrice,
    discountPercent: !isShipping || (draft.discountShipping ?? config.shipping.discountByDefault) ? draft.discountPercent : 0,
    vatId: binding.vatId, vatRate: rule.rate, nature: binding.nature, shipping: isShipping,
  });
  const due = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(due.getTime()) || due.toISOString().slice(0, 10) !== date) throw new Error('Invalid order date');
  due.setUTCDate(due.getUTCDate() + config.payments.dueDays);
  const deliveryNote = draft.delivery ? `${config.clients.shippingNotesLabel}: ${draft.delivery.address}` : '';
  return { ready: true, draft, order: preparedOrderSchema.parse({
    type: 'order', policyVersion: config.policyVersion, currency: config.currency, client,
    lines: [...selected.map(({ product, quantity, netPrice }) => makeLine(product, quantity, false, netPrice)), ...(shippingPrice > 0 ? [makeLine(shipping, 1, true)] : [])],
    delivery, notes: [draft.notes, deliveryNote].filter(Boolean).join('\n'), date,
    paymentMethodId: config.payments.methodId, dueDate: due.toISOString().slice(0, 10),
  }) };
}
