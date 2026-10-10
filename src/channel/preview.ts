import type { Client, Issue, NewCustomer, OrderDraft, PreparedOrder, Totals } from '../domain/types.js';
import type { Discrepancy } from '../domain/history.js';

const rule = '━━━━━━━━━━━━━━━━';

function money(amount: number, it: boolean) {
  const text = amount.toFixed(2);
  return `€${it ? text.replace('.', ',') : text}`;
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
    if (issue.field.endsWith('.quantity')) return it ? `quantità per ${query}` : `quantity for ${query}`;
    if (issue.priceComparison) return it ? `prezzo di ${query}` : `price of ${query}`;
    return it ? `prodotto per ${query}` : `product for ${query}`;
  }
  if (issue.field === 'client' || issue.field.startsWith('client.')) {
    const field = issue.field.slice('client.'.length);
    return issue.field === 'client' ? (it ? 'cliente' : 'customer') : `${it ? 'cliente' : 'customer'}: ${fieldLabel(field, it).toLowerCase()}`;
  }
  const labels: Record<string, [string, string]> = {
    shippingPrice: ['costo di consegna', 'delivery charge'], 'delivery.country': ['paese di consegna', 'delivery country'],
    vat: ['controllo IVA', 'VAT check'], priceTier: ['listino prezzi', 'price list'], lines: ['prodotti e quantità', 'products and quantities'],
  };
  return labels[issue.field]?.[it ? 0 : 1] ?? (it ? 'altri dettagli' : 'other details');
}

/** Fields whose identity the operator can pick with a button under the draft. */
export const pickable = (issue: Issue) => (issue.field === 'client' || /^lines\.\d+$/.test(issue.field)) && !!issue.candidates?.length;

/** An order still being completed: what is known so far, with ❓ where something is missing. */
export function orderDraft(draft: OrderDraft, issues: Issue[], it: boolean, client?: Client) {
  const open = new Set(issues.map(issue => issue.field));
  const lines = [it ? '📝 Bozza ordine' : '📝 Draft order', rule, ''];
  if (client) lines.push(`🏪 ${client.name}`, ...(client.vatNumber ? [`🧾 ${it ? 'P. IVA' : 'VAT'} ${client.vatNumber}`] : []), `📍 ${place(client)}`);
  else {
    const name = draft.newClient?.name ?? draft.clientQuery.trim();
    lines.push(`🏪 ${name ? `${name}${draft.newClient ? (it ? ' (nuovo)' : ' (new)') : ''} ❓` : '❓'}`);
  }
  lines.push('', it ? '🧴 Prodotti' : '🧴 Products');
  if (!draft.lines.length) lines.push('❓');
  for (const [index, line] of draft.lines.entries()) {
    const unsure = [...open].some(field => field === `lines.${index}` || field === `lines.${index}.documentPrice`);
    const quantity = line.quantity === undefined ? '❓' : String(line.quantity);
    const price = line.netPrice === undefined ? '' : ` — ${money(line.netPrice, it)}`;
    lines.push(`${quantity} × ${line.query}${price}${unsure ? ' ❓' : ''}`);
  }
  lines.push('', `🚚 ${it ? 'Consegna' : 'Delivery'}: ${draft.shippingPrice === undefined ? '❓' : draft.shippingPrice === 0 ? (it ? 'nessuna' : 'none') : money(draft.shippingPrice, it)}`);
  if (draft.delivery) lines.push(`📦 ${it ? 'Spedire a' : 'Ship to'}: ${draft.delivery.address}${draft.delivery.country ? `, ${draft.delivery.country}` : ' ❓'}`);
  if (draft.discountPercent > 0) lines.push(`💸 ${it ? 'Sconto' : 'Discount'} ${draft.discountPercent}%`);
  if (draft.notes.trim()) lines.push('', it ? '📝 Note' : '📝 Notes', draft.notes.trim());
  const points = [...new Set(issues.map(issue => openPoint(issue, draft, it)))];
  if (points.length) lines.push('', `❓ ${it ? 'Da completare' : 'To complete'}: ${points.join(' · ')}`);
  return lines.join('\n');
}

const fieldLabels: Record<string, [string, string]> = {
  name: ['Nome', 'Name'], street: ['Via', 'Street'], postalCode: ['CAP', 'Postal code'], city: ['Città', 'City'], country: ['Paese', 'Country'],
  vatNumber: ['Partita IVA', 'VAT number'], taxCode: ['Codice fiscale', 'Tax code'], sdiCode: ['Codice SDI', 'SDI code'],
  certifiedEmail: ['PEC', 'PEC (certified email)'], phone: ['Telefono', 'Phone'], email: ['Email', 'Email'],
};
const fieldLabel = (field: string, it: boolean) => fieldLabels[field]?.[it ? 0 : 1] ?? field;

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
  return it ? `Cliente già presente: ${client.name} (ID ${client.id}). Nessun nuovo cliente creato.` : `Customer already exists: ${client.name} (ID ${client.id}). No new customer created.`;
}

/** A new customer: complete and ready to confirm, or a draft with the details still missing. */
export function customerPreview(client: Partial<NewCustomer>, it: boolean, missing: string[] = []) {
  const address = place(client);
  const lines = [it ? '👤 Nuovo cliente' : '👤 New customer', rule, '', `🏪 ${client.name ?? '❓'}`, ...(address ? ['', `📍 ${address}`] : [])];
  const contact = [client.email ? `✉️ ${client.email}` : '', client.certifiedEmail ? `📨 PEC ${client.certifiedEmail}` : '', client.phone ? `📞 ${client.phone}` : ''].filter(Boolean);
  if (contact.length) lines.push('', ...contact);
  const tax = [
    client.vatNumber ? `🧾 ${it ? 'P. IVA' : 'VAT'} ${client.vatNumber}` : '',
    client.taxCode ? `👤 ${it ? 'Codice fiscale' : 'Tax code'} ${client.taxCode}` : '',
    client.sdiCode ? `🔢 SDI ${client.sdiCode}` : '',
  ].filter(Boolean);
  if (tax.length) lines.push('', ...tax);
  if (client.notes?.trim()) lines.push('', it ? '📝 Note' : '📝 Notes', client.notes.trim());
  if (missing.length) {
    lines.push('', `❓ ${it ? 'Da completare' : 'To complete'}: ${missing.map(field => fieldLabel(field, it).toLowerCase()).join(' · ')}`);
    return lines.join('\n');
  }
  const optional = optionalCustomerFields(client, it);
  if (optional.length) lines.push('', it ? '➕ Facoltativi, puoi aggiungere:' : '➕ Optional, you can add:', ...optional.map(field => `• ${field}`));
  if (!client.street || !client.city || !client.postalCode || !client.country) lines.push('', it ? 'ℹ️ Per fare un ordine servono indirizzo e paese.' : 'ℹ️ Orders need the address and country.');
  return lines.join('\n');
}


function day(date: string, it: boolean) {
  const [y, m, d] = date.split('-');
  return y && m && d ? (it ? `${d}/${m}/${y}` : date) : date;
}

/** A complete order ready to confirm. Price differences from earlier orders are shown to check; they never block saving. */
export function orderPreview(order: PreparedOrder, totals: Totals, it: boolean, discrepancies: Discrepancy[] = []) {
  const goods = order.lines.filter(line => !line.shipping);
  const shipping = order.lines.filter(line => line.shipping);
  const rates = [...new Set(order.lines.map(line => `${line.vatRate}%${line.nature ? ` ${line.nature}` : ''}`))];
  const lines = [it ? '📦 Anteprima ordine' : '📦 Order preview', rule, '', `🏪 ${order.client.name}`];
  if (order.client.vatNumber) lines.push(`🧾 ${it ? 'P. IVA' : 'VAT'} ${order.client.vatNumber}`);
  lines.push('', `📍 ${place(order.client)}`, '', it ? '🧴 Prodotti' : '🧴 Products');
  for (const line of [...goods, ...shipping]) {
    const discount = line.discountPercent > 0 ? ` — ${line.discountPercent}% ${it ? 'sconto' : 'discount'}` : '';
    lines.push(`${line.quantity} × ${line.name} — ${money(line.netPrice, it)}${discount}`);
  }
  lines.push('', it ? '💶 Totali' : '💶 Totals', `${it ? 'Imponibile' : 'Net'} ${money(totals.net, it)}`, `${it ? 'IVA' : 'VAT'} ${rates.join(', ')} ${money(totals.vat, it)}`, `${it ? 'Totale' : 'Total'} ${money(totals.gross, it)}`);
  if (order.notes.trim()) lines.push('', it ? '📝 Note' : '📝 Notes', order.notes.trim());
  const checks = discrepancies.map(d => it
      ? `${d.name}: ora ${money(d.now, it)}, ordine precedente ${money(d.before, it)} (#${d.order.number}, ${day(d.order.date, it)})`
      : `${d.name}: now ${money(d.now, it)}, previous order ${money(d.before, it)} (#${d.order.number}, ${day(d.order.date, it)})`);
  if (checks.length) lines.push('', it ? '⚠️ Da verificare' : '⚠️ To check', ...checks.map(c => `• ${c}`));
  return lines.join('\n');
}
