import type { AppConfig } from '../config/schema.js';
import type { OrderConnector } from '../connector/contract.js';
import { prepareOrder, type ValidationLookup } from '../domain/prepare.js';
import type { Client, Issue, NewCustomer, OrderDraft, PreparedOrder, Product, Totals } from '../domain/types.js';
import { changedIdentities, type Decision, type IdentityResolver, type ResolutionContext } from '../matching/resolver.js';
import { customerDetails } from '../domain/customer.js';
import { priceDiscrepancies, type CatalogueIncrease, type Discrepancy } from '../domain/history.js';
import { traceOperation } from './execution-trace.js';

/** What the order API reports: a prepared order ready for confirmation, or what is still needed. */
export type OrderResult = { kind: 'order'; draft: OrderDraft; decisions: Decision[]; client?: Client } & (
  | { status: 'ready'; order: PreparedOrder; totals: Totals; discrepancies: Discrepancy[]; catalogueIncreases: CatalogueIncrease }
  | { status: 'needs'; issues: Issue[] });
/** What the customer API reports: a customer ready to create, an existing one, or what is still needed. */
export type CustomerResult = { kind: 'customer'; draft: OrderDraft; decisions: Decision[] } & (
  | { status: 'ready'; customer: NewCustomer }
  | { status: 'existing'; client: { id: string; name: string } }
  | { status: 'needs'; issues: Issue[] });
export type DraftResult = OrderResult | CustomerResult;

export const identityStatus = ['accepted', 'unconfirmed', 'ambiguous', 'unsupported', 'missing'] as const;
export type IdentityStatus = (typeof identityStatus)[number];

function mergeIssues(identity: Issue[], commercial: Issue[]) {
  const fields = new Set(identity.map(issue => issue.field));
  return [...identity, ...commercial.filter(issue => !fields.has(issue.field) && !identity.some(item => issue.field.startsWith(`${item.field}.`)))];
}

async function withLastPaid(issues: Issue[], draft: OrderDraft, connector: OrderConnector) {
  const shipping = issues.find(issue => issue.field === 'shippingPrice');
  if (!shipping || draft.clientId === undefined) return issues;
  try {
    const history = await connector.listClientOrders(draft.clientId, 5);
    for (const order of history) {
      const hit = order.lines.find(item => item.netPrice > 0 && (/deliver|spediz|shipping/i.test(`${item.name} ${item.code}`) || item.code === 'DELIVERY'));
      if (hit) {
        return issues.map(issue => issue.field === 'shippingPrice'
          ? { ...issue, lastPaidPrice: hit.netPrice, message: `${issue.message}. Last paid ${hit.netPrice} on #${order.number}` }
          : issue);
      }
    }
  } catch { /* history is an offer, never a gate */ }
  return issues;
}

/**
 * The order and customer APIs: validation only, never a write. One identity pass, then commercial preparation.
 */
export function createDraftApi(config: AppConfig, connector: OrderConnector, matching: IdentityResolver, validateVat?: ValidationLookup) {
  async function order(input: OrderDraft, context: ResolutionContext, date = new Date().toISOString().slice(0, 10)): Promise<OrderResult> {
    const resolution = await traceOperation('Resolve identities', () => matching.resolve(input, context), {
      reasons: 'pending',
    });
    const { draft, decisions } = resolution;
    await traceOperation('Identity decisions', async () => decisions, {
      fields: decisions.map(d => ({ field: d.field, status: d.status, source: d.source, reason: d.reason })),
    });
    let products: Product[] = [], clients: Client[] = [];
    const result = await traceOperation('Prepare order', () => prepareOrder(draft, config, {
      listProducts: async () => products = await connector.listProducts(),
      listClients: async () => clients = await connector.listClients(),
    }, date, validateVat, context.operatorText));
    const changed = matching.mode === 'on' ? changedIdentities(decisions, products, clients) : [];
    const issues = mergeIssues(changed, mergeIssues(resolution.issues, result.ready ? [] : result.issues));
    if (changed.length || issues.length || !result.ready) {
      const clientId = draft.clientId ?? (!result.ready ? result.clientId : undefined);
      const client = clientId ? clients.find(c => c.id === clientId) : undefined;
      const open = await withLastPaid(issues, result.draft, connector);
      return { kind: 'order', status: 'needs', draft: result.draft, decisions, issues: open, ...(client ? { client } : {}) };
    }
    const id = result.order.client.id;
    const [totals, history] = await Promise.all([connector.calculateTotals(result.order), id ? connector.listClientOrders(id, 5).catch(() => []) : []]);
    const compared = priceDiscrepancies(result.order, history, products);
    return { kind: 'order', status: 'ready', draft: result.draft, decisions, order: result.order, totals, discrepancies: compared.anomalies, catalogueIncreases: compared.catalogueIncreases, client: result.order.client };
  }

  async function customer(input: OrderDraft, context: ResolutionContext): Promise<CustomerResult> {
    const resolution = await traceOperation('Resolve identities', () => matching.resolve({ ...input, lines: [] }, context));
    const { draft, decisions } = resolution;
    if (resolution.issues.length) return { kind: 'customer', status: 'needs', draft, decisions, issues: resolution.issues };
    if (draft.clientId) return { kind: 'customer', status: 'existing', draft, decisions, client: { id: draft.clientId, name: draft.clientQuery } };
    const details = customerDetails(draft, config);
    if (!details.client) return { kind: 'customer', status: 'needs', draft, decisions, issues: details.missing.map(field => ({ field: `client.${field}`, message: `Missing required customer field: ${field}` })) };
    return { kind: 'customer', status: 'ready', draft, decisions, customer: details.client };
  }

  return { order, customer };
}
export type DraftApi = ReturnType<typeof createDraftApi>;

function fieldStatus(issues: Issue[] | undefined, field: string, accepted: boolean): IdentityStatus {
  if (accepted) return 'accepted';
  const issue = issues?.find(item => item.field === field);
  if (!issue) return field === 'client' ? 'missing' : 'missing';
  if (issue.matchingStatus === 'unavailable') return 'unsupported';
  if (issue.matchingStatus === 'no-match' && !issue.candidates?.length) return 'unsupported';
  if (issue.matchingStatus === 'ambiguous' || (issue.candidates?.length ?? 0) > 1) return 'ambiguous';
  if (issue.candidates?.length) return 'unconfirmed';
  return issue.matchingStatus === 'no-match' ? 'unsupported' : 'unconfirmed';
}

export const issuesForAgent = (issues: Issue[]) => issues.map(i => ({
  field: i.field, problem: i.message,
  ...(i.candidates?.length ? { candidates: i.candidates.map(c => c.label) } : {}),
}));

/** The part of a result the agent reads back. Record IDs stay with the application. */
export function forAgent(result: DraftResult, revision?: number) {
  const issues = result.status === 'needs' ? result.issues : undefined;
  const customerStatus = fieldStatus(issues, 'client', result.kind === 'order' && !!result.client);
  const customer = result.kind === 'order' && result.client
    ? { status: 'accepted' as const, name: result.client.name, ...(result.client.city ? { city: result.client.city } : {}), ...(result.client.vatNumber ? { vatNumber: result.client.vatNumber } : {}) }
    : result.draft.clientQuery.trim()
      ? {
        status: customerStatus,
        query: result.draft.clientQuery,
        ...(issues?.find(i => i.field === 'client')?.candidates?.length ? { candidates: issues.find(i => i.field === 'client')!.candidates!.map(c => c.label) } : {}),
        action: customerStatus === 'accepted' ? undefined : 'Ask the operator to pick or type the legal name or VAT.',
      }
      : { status: 'missing' as const, action: 'Ask who the customer is.' };
  const lines = result.kind === 'order'
    ? result.draft.lines.map((line, index) => {
      const field = `lines.${index}`;
      const status = fieldStatus(issues, field, Boolean(line.productId));
      const issue = issues?.find(item => item.field === field);
      return {
        ref: line.ref ?? `L${index + 1}`,
        query: line.query,
        quantity: line.quantity,
        ...(line.tester ? { tester: true as const } : {}),
        status,
        ...(status === 'accepted' ? {} : {
          ...(issue?.candidates?.length ? { candidates: issue.candidates.map(c => c.label) } : {}),
          action: status === 'unsupported' ? 'Look the catalogue up; do not send a different product as the requested item.' : 'Ask the operator to pick, or send a more specific code.',
        }),
      };
    })
    : undefined;
  const shipping = result.kind === 'order'
    ? result.draft.shippingPrice === undefined
      ? { status: 'unknown' as const, action: 'Ask the delivery charge. Do not say it is 0 while status is unknown.' }
      : { status: 'set' as const, amount: result.draft.shippingPrice }
    : undefined;
  return {
    status: result.status,
    ...(revision !== undefined ? { revision } : {}),
    customer,
    ...(lines ? { lines } : {}),
    ...(shipping ? { shipping } : {}),
    ...(result.status === 'needs' ? { issues: issuesForAgent(result.issues) } : {}),
    note: result.status === 'needs'
      ? 'Shown to the operator with these points. Use customer.status, lines[].status and shipping.status: accepted is already selected; unconfirmed and ambiguous still need a pick or exact name; unsupported is not in the catalogue as requested. shipping.status unknown is not 0; amount 0 means no charge. Ask about the returned issues. Never say the draft is ready while status is needs.'
      : result.status === 'existing' ? 'This customer already exists; nothing will be created.'
      : 'Complete, and shown to the operator for review.',
  };
}
