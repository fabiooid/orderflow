import type { Client, Issue, NewCustomer, OrderDraft, PreparedOrder, Totals } from '../domain/types.js';
import type { Discrepancy } from '../domain/history.js';
import { copy, type CopyKey, type CopyVars } from './locales/index.js';

const rule = '━━━━━━━━━━━━━━━━';

function say(it: boolean, key: CopyKey, vars?: CopyVars) {
  return copy(it ? 'it' : 'en', key, vars);
}

/** EUR keeps the existing €12,00 / €12.00 layout. Any other ISO code is shown after the amount. */
function money(amount: number, it: boolean, currency: string) {
  const shown = amount.toFixed(2);
  const text = it ? shown.replace('.', ',') : shown;
  return currency === 'EUR' ? `€${text}` : `${text} ${currency}`;
}

function place(client: Partial<Pick<NewCustomer, 'street' | 'postalCode' | 'city' | 'province' | 'country'>>) {
  return [client.street, [client.postalCode, client.city].filter(Boolean).join(' '), client.province, client.country].filter(Boolean).join(', ');
}

/** The line an issue or choice field such as `lines.2` or `lines.2.quantity` refers to. */
export const lineIndex = (field: string) => { const match = /^lines\.(\d+)/.exec(field); return match ? Number(match[1]) : undefined; };

/** One short label per open point: the agent asks the actual questions, the template only marks what is missing. */
function openPoint(issue: Issue, draft: OrderDraft, it: boolean) {
  const index = lineIndex(issue.field);
  const query = index === undefined ? undefined : draft.lines[index]?.query;
  if (query !== undefined) {
    if (issue.field.endsWith('.quantity')) return say(it, 'draftQuantityFor', { query });
    if (issue.priceComparison) return say(it, 'draftPriceOf', { query });
    return say(it, 'draftProductFor', { query });
  }
  if (issue.field === 'client' || issue.field.startsWith('client.')) {
    const field = issue.field.slice('client.'.length);
    const customer = say(it, 'draftCustomer');
    return issue.field === 'client' ? customer : `${customer}: ${fieldLabel(field, it).toLowerCase()}`;
  }
  const labels: Record<string, CopyKey> = {
    shippingPrice: 'issueShipping', 'delivery.country': 'issueCountry',
    vat: 'issueVat', priceTier: 'issueTier', lines: 'issueLines',
  };
  const key = labels[issue.field];
  return key ? say(it, key) : say(it, 'draftOther');
}

/** Fields whose identity the operator can pick with a button under the draft. */
export const pickable = (issue: Issue) => (issue.field === 'client' || /^lines\.\d+$/.test(issue.field)) && !!issue.candidates?.length;

/** An order still being completed: what is known so far, with ❓ where something is missing. */
export function orderDraft(draft: OrderDraft, issues: Issue[], it: boolean, client?: Client, currency = 'EUR') {
  const open = new Set(issues.map(issue => issue.field));
  const lines = [say(it, 'draftOrder'), rule, ''];
  if (client) lines.push(`🏪 ${client.name}`, ...(client.vatNumber ? [`🧾 ${say(it, 'vatShort')} ${client.vatNumber}`] : []), `📍 ${place(client)}`);
  else {
    const name = draft.newClient?.name ?? draft.clientQuery.trim();
    lines.push(`🏪 ${name ? `${name}${draft.newClient ? say(it, 'draftNew') : ''} ❓` : '❓'}`);
  }
  lines.push('', say(it, 'draftProducts'));
  if (!draft.lines.length) lines.push('❓');
  for (const [index, line] of draft.lines.entries()) {
    const unsure = [...open].some(field => field === `lines.${index}` || field === `lines.${index}.documentPrice`);
    const quantity = line.quantity === undefined ? '❓' : String(line.quantity);
    const price = line.netPrice === undefined ? '' : ` — ${money(line.netPrice, it, currency)}`;
    lines.push(`${quantity} × ${line.query}${price}${unsure ? ' ❓' : ''}`);
  }
  lines.push('', `🚚 ${say(it, 'draftDelivery')}: ${draft.shippingPrice === undefined ? '❓' : draft.shippingPrice === 0 ? say(it, 'draftNone') : money(draft.shippingPrice, it, currency)}`);
  if (draft.delivery) lines.push(`📦 ${say(it, 'draftShipTo')}: ${draft.delivery.address}${draft.delivery.country ? `, ${draft.delivery.country}` : ' ❓'}`);
  if (draft.discountPercent > 0) lines.push(`💸 ${say(it, 'draftDiscount')} ${draft.discountPercent}%`);
  if (draft.notes.trim()) lines.push('', say(it, 'draftNotes'), draft.notes.trim());
  const points = [...new Set(issues.map(issue => openPoint(issue, draft, it)))];
  if (points.length) lines.push('', `❓ ${say(it, 'draftToComplete')}: ${points.join(' · ')}`);
  return lines.join('\n');
}

const fieldLabels: Record<string, CopyKey> = {
  name: 'fieldName', street: 'fieldStreet', postalCode: 'fieldPostalCode', city: 'fieldCity', country: 'fieldCountry',
  vatNumber: 'fieldVat', taxCode: 'fieldTaxCode', sdiCode: 'fieldSdi',
  certifiedEmail: 'fieldPec', phone: 'fieldPhone', email: 'fieldEmail',
};
const fieldLabel = (field: string, it: boolean) => fieldLabels[field] ? say(it, fieldLabels[field]) : field;

/** Details Fatture in Cloud accepts but does not require. SDI and PEC apply to Italian customers, assumed when no country is given. */
export function optionalCustomerFields(client: Partial<NewCustomer>, it: boolean) {
  const italian = !client.country || client.country === 'IT';
  const fields: string[] = (['street', 'postalCode', 'city', 'country'] as const).filter(field => !client[field]).map(field => fieldLabel(field, it));
  if (!client.vatNumber && !client.taxCode) fields.push(`${fieldLabel('vatNumber', it)} / ${fieldLabel('taxCode', it).toLowerCase()}`);
  if (italian && !client.sdiCode) fields.push(fieldLabel('sdiCode', it));
  if (italian && !client.certifiedEmail) fields.push(fieldLabel('certifiedEmail', it));
  if (!client.phone) fields.push(fieldLabel('phone', it));
  if (!client.email) fields.push(fieldLabel('email', it));
  return fields;
}

/** A customer request that matched an existing customer: nothing is created. */
export function existingCustomer(client: { id: number; name: string }, it: boolean) {
  return say(it, 'customerAlready', { name: client.name, id: client.id });
}

/** A new customer: complete and ready to confirm, or a draft with the details still missing. */
export function customerPreview(client: Partial<NewCustomer>, it: boolean, missing: string[] = []) {
  const address = place(client);
  const lines = [say(it, 'newCustomerTitle'), rule, '', `🏪 ${client.name ?? '❓'}`, ...(address ? ['', `📍 ${address}`] : [])];
  const contact = [client.email ? `✉️ ${client.email}` : '', client.certifiedEmail ? `📨 PEC ${client.certifiedEmail}` : '', client.phone ? `📞 ${client.phone}` : ''].filter(Boolean);
  if (contact.length) lines.push('', ...contact);
  const tax = [
    client.vatNumber ? `🧾 ${say(it, 'vatShort')} ${client.vatNumber}` : '',
    client.taxCode ? `👤 ${fieldLabel('taxCode', it)} ${client.taxCode}` : '',
    client.sdiCode ? `🔢 SDI ${client.sdiCode}` : '',
  ].filter(Boolean);
  if (tax.length) lines.push('', ...tax);
  if (client.notes?.trim()) lines.push('', say(it, 'draftNotes'), client.notes.trim());
  if (missing.length) {
    lines.push('', `❓ ${say(it, 'draftToComplete')}: ${missing.map(field => fieldLabel(field, it).toLowerCase()).join(' · ')}`);
    return lines.join('\n');
  }
  const optional = optionalCustomerFields(client, it);
  if (optional.length) lines.push('', say(it, 'optionalHint'), ...optional.map(field => `• ${field}`));
  if (!client.street || !client.city || !client.postalCode || !client.country) lines.push('', say(it, 'orderNeedsAddress'));
  return lines.join('\n');
}


function day(date: string, it: boolean) {
  const [y, m, d] = date.split('-');
  return y && m && d ? (it ? `${d}/${m}/${y}` : date) : date;
}

/** A complete order ready to confirm. Price differences from earlier orders are shown to check; they never block saving. */
export function orderPreview(order: PreparedOrder, totals: Totals, it: boolean, discrepancies: Discrepancy[] = [], currency = 'EUR') {
  const goods = order.lines.filter(line => !line.shipping);
  const shipping = order.lines.filter(line => line.shipping);
  const rates = [...new Set(order.lines.map(line => `${line.vatRate}%${line.nature ? ` ${line.nature}` : ''}`))];
  const lines = [say(it, 'orderPreviewTitle'), rule, '', `🏪 ${order.client.name}`];
  if (order.client.vatNumber) lines.push(`🧾 ${say(it, 'vatShort')} ${order.client.vatNumber}`);
  lines.push('', `📍 ${place(order.client)}`, '', say(it, 'draftProducts'));
  for (const line of [...goods, ...shipping]) {
    const discount = line.discountPercent > 0 ? ` — ${line.discountPercent}% ${say(it, 'lineDiscount')}` : '';
    lines.push(`${line.quantity} × ${line.name} — ${money(line.netPrice, it, currency)}${discount}`);
  }
  lines.push('', say(it, 'totalsTitle'), `${say(it, 'totalNet')} ${money(totals.net, it, currency)}`, `${say(it, 'totalVat')} ${rates.join(', ')} ${money(totals.vat, it, currency)}`, `${say(it, 'totalGross')} ${money(totals.gross, it, currency)}`);
  if (order.notes.trim()) lines.push('', say(it, 'draftNotes'), order.notes.trim());
  const checks = discrepancies.map(d => say(it, 'priceNow', {
    name: d.name, now: money(d.now, it, currency), before: money(d.before, it, currency), number: d.order.number, date: day(d.order.date, it),
  }));
  if (checks.length) lines.push('', say(it, 'toCheck'), ...checks.map(c => `• ${c}`));
  return lines.join('\n');
}
