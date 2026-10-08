import { MAX_CHOICES } from '../domain/matching.js';
import type { Client, Issue, OrderDraft, PreparedOrder, Totals } from '../domain/types.js';
import type { Discrepancy } from '../domain/history.js';

const rule = '━━━━━━━━━━━━━━━━';

function money(amount: number, it: boolean) {
  const text = amount.toFixed(2);
  return `€${it ? text.replace('.', ',') : text}`;
}

function place(client: Pick<Client, 'street' | 'postalCode' | 'city' | 'province' | 'country'>) {
  return [client.street, [client.postalCode, client.city].join(' '), client.province, client.country].filter(Boolean).join(', ');
}

export function lineQuery(field: string, draft: OrderDraft) {
  const index = /^lines\.(\d+)/.exec(field);
  return index ? draft.lines[Number(index[1])]?.query : undefined;
}

/** Each question stays with its own product and its own choices, whoever wrote the wording. */
export function askedText(issues: Issue[], draft: OrderDraft, it: boolean, wording: Record<string, string> = {}) {
  return issues.map(issue => {
    const query = lineQuery(issue.field, draft);
    if (issue.priceComparison) {
      const p = issue.priceComparison;
      const basis = p.basis === 'net' ? (it ? 'netto' : 'net') : p.basis === 'gross' ? (it ? 'IVA inclusa' : 'VAT included') : (it ? 'base IVA non chiara' : 'VAT basis unclear');
      return it
        ? `Per ${query}: il modulo indica ${money(p.document, true)} (${basis}); FiC indica ${money(p.catalogue, true)} netto. Usiamo FiC oppure confermi il prezzo netto da applicare a questo ordine?`
        : `For ${query}: the form shows ${money(p.document, false)} (${basis}); FiC shows ${money(p.catalogue, false)} net. Use FiC, or confirm the net price to apply to this order?`;
    }
    const choices = (issue.candidates ?? []).slice(0, MAX_CHOICES).map(candidate => candidate.label);
    const list = choices.length ? `\n${choices.join('\n')}` : '';
    const written = wording[issue.field]?.trim();
    if (written) return `${written}${list}`;
    if (query && choices.length) return `${it ? `Per ${query}, quale prodotto scegli?` : `For ${query}, which product?`}${list}`;
    if (query && issue.field.endsWith('.quantity')) return it ? `Quanti pezzi per ${query}?` : `How many for ${query}?`;
    if (query && issue.field.endsWith('.netPrice')) return it ? `Quale prezzo netto per ${query}?` : `What net price for ${query}?`;
    if (query) return it ? `Non trovo un prodotto per ${query}.` : `No product found for ${query}.`;
    if (issue.field === 'shippingPrice') return it ? 'Qual è il costo di consegna?' : 'What is the delivery price?';
    if (issue.field === 'client') return `${it ? 'Quale cliente?' : 'Which client?'}${list}`;
    if (issue.field === 'vat') return it ? 'Serve un controllo sull’IVA.' : 'A VAT check is needed.';
    return `${issue.message}${list}`;
  }).join('\n\n');
}

export function customerPreview(client: Client, it: boolean) {
  const lines = [it ? '👤 Nuovo cliente' : '👤 New customer', rule, '', `🏪 ${client.name}`, '', `📍 ${place(client)}`];
  const contact = [client.email ? `✉️ ${client.email}` : '', client.phone ? `📞 ${client.phone}` : ''].filter(Boolean);
  if (contact.length) lines.push('', ...contact);
  const tax = [
    client.vatNumber ? `🧾 ${it ? 'P. IVA' : 'VAT'} ${client.vatNumber}` : '',
    client.taxCode ? `👤 ${it ? 'Codice fiscale' : 'Tax code'} ${client.taxCode}` : '',
    client.sdiCode ? `🔢 SDI ${client.sdiCode}` : '',
  ].filter(Boolean);
  if (tax.length) lines.push('', ...tax);
  if (client.notes.trim()) lines.push('', '📝 Note', client.notes.trim());
  lines.push('', ...(it
    ? ['Rispondi con le correzioni.', 'Usa il pulsante Conferma e salva (oppure /confermacliente)', '/annulla per annullare']
    : ['Reply with corrections.', 'Use Confirm and save (or /confirmcustomer)', '/cancel to cancel']));
  return lines.join('\n');
}

/** Things the operator should look at before confirming; they never block saving. */
export type Review = { tierName?: string; discrepancies?: Discrepancy[]; warnings?: string[] };

function day(date: string, it: boolean) {
  const [y, m, d] = date.split('-');
  return y && m && d ? (it ? `${d}/${m}/${y}` : date) : date;
}

export function orderPreview(order: PreparedOrder, totals: Totals, it: boolean, canSave: boolean, review: Review = {}) {
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
  if (review.tierName) lines.push('', `🏷️ ${it ? 'Prezzi' : 'Prices'}: ${it ? 'listino' : 'price list'} ${review.tierName}`);
  lines.push('', it ? '💶 Totali' : '💶 Totals', `${it ? 'Imponibile' : 'Net'} ${money(totals.net, it)}`, `IVA ${rates.join(', ')} ${money(totals.vat, it)}`, `${it ? 'Totale' : 'Total'} ${money(totals.gross, it)}`);
  if (order.notes.trim()) lines.push('', '📝 Note', order.notes.trim());
  const checks = [
    ...(review.warnings ?? []),
    ...(review.discrepancies ?? []).map(d => it
      ? `${d.name}: ora ${money(d.now, it)}, ordine precedente ${money(d.before, it)} (#${d.order.number}, ${day(d.order.date, it)})`
      : `${d.name}: now ${money(d.now, it)}, previous order ${money(d.before, it)} (#${d.order.number}, ${day(d.order.date, it)})`),
  ];
  if (checks.length) lines.push('', it ? '⚠️ Da verificare' : '⚠️ To check', ...checks.map(c => `• ${c}`));
  const actions = it
    ? ['Rispondi con le modifiche.', canSave ? 'Usa Conferma e salva per ricevere il PDF (oppure /confermaordine)' : '/review per segnare il controllo', '/annulla per annullare']
    : ['Reply with changes.', canSave ? 'Use Confirm and save to receive the PDF (or /confirmorder)' : '/review to mark it checked', '/cancel to cancel'];
  lines.push('', ...actions);
  return lines.join('\n');
}
