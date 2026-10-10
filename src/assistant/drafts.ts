import type { AppConfig } from '../config/schema.js';
import type { OrderConnector } from '../connector/contract.js';
import { prepareOrder, type ValidationLookup } from '../domain/prepare.js';
import type { Client, Issue, NewCustomer, OrderDraft, PreparedOrder, Product, Totals } from '../domain/types.js';
import { changedIdentities, type Decision, type IdentityResolver, type ResolutionContext } from '../matching/resolver.js';
import { customerDetails } from '../domain/customer.js';
import { priceDiscrepancies, type Discrepancy } from '../domain/history.js';
import { traceOperation } from './execution-trace.js';

/** What the order API reports: a prepared order ready for confirmation, or what is still needed. */
export type OrderResult = { kind: 'order'; draft: OrderDraft; decisions: Decision[]; client?: Client } & (
  /** `discrepancies`: prices that differ from the customer's previous orders, to check; they never block saving. */
  | { status: 'ready'; order: PreparedOrder; totals: Totals; discrepancies: Discrepancy[] }
  | { status: 'needs'; issues: Issue[] });
/** What the customer API reports: a customer ready to create, an existing one, or what is still needed. */
export type CustomerResult = { kind: 'customer'; draft: OrderDraft; decisions: Decision[] } & (
  | { status: 'ready'; customer: NewCustomer }
  | { status: 'existing'; client: { id: string; name: string } }
  | { status: 'needs'; issues: Issue[] });
export type DraftResult = OrderResult | CustomerResult;

/**
 * The order and customer APIs: validation only, never a write. Identities go through the resolver, which accepts an
 * ID only from exact evidence in the operator's words, a judged match or the operator's own button choice.
 */
export function createDraftApi(config: AppConfig, connector: OrderConnector, matching: IdentityResolver, validateVat?: ValidationLookup) {
  async function order(input: OrderDraft, context: ResolutionContext, date = new Date().toISOString().slice(0, 10)): Promise<OrderResult> {
    const resolution = await traceOperation('Resolve identities', () => matching.resolve(input, context));
    const { draft, decisions } = resolution;
    let products: Product[] = [], clients: Client[] = [];
    if (resolution.issues.length) {
      // The customer already identified is shown on the draft, so a wrong one is visible while other points are open.
      const client = draft.clientId ? (await connector.listClients().catch(() => [])).find(c => c.id === draft.clientId) : undefined;
      return { kind: 'order', status: 'needs', draft, decisions, issues: resolution.issues, ...(client ? { client } : {}) };
    }
    const result = await traceOperation('Prepare order', () => prepareOrder(draft, config, {
      listProducts: async () => products = await connector.listProducts(),
      listClients: async () => clients = await connector.listClients(),
    }, date, validateVat));
    const changed = matching.mode === 'on' ? changedIdentities(decisions, products, clients) : [];
    if (changed.length) return { kind: 'order', status: 'needs', draft, decisions, issues: changed };
    if (!result.ready) {
      const client = clients.find(c => c.id === (result.clientId ?? draft.clientId));
      return { kind: 'order', status: 'needs', draft: result.draft, decisions, issues: result.issues, ...(client ? { client } : {}) };
    }
    const id = result.order.client.id;
    // Lookup failures only drop the price comparison.
    const [totals, history] = await Promise.all([connector.calculateTotals(result.order), id ? connector.listClientOrders(id, 5).catch(() => []) : []]);
    return { kind: 'order', status: 'ready', draft: result.draft, decisions, order: result.order, totals, discrepancies: priceDiscrepancies(result.order, history), client: result.order.client };
  }

  /** Matching still runs on a new customer, so a near-duplicate of an existing one is offered rather than recreated. */
  async function customer(input: OrderDraft, context: ResolutionContext): Promise<CustomerResult> {
    const resolution = await traceOperation('Resolve identities', () => matching.resolve({ ...input, lines: [] }, context));
    const { draft, decisions } = resolution;
    if (resolution.issues.length) return { kind: 'customer', status: 'needs', draft, decisions, issues: resolution.issues };
    if (matching.mode === 'on' && draft.clientId) return { kind: 'customer', status: 'existing', draft, decisions, client: { id: draft.clientId, name: draft.clientQuery } };
    const details = customerDetails(draft, config);
    if (!details.client) return { kind: 'customer', status: 'needs', draft, decisions, issues: details.missing.map(field => ({ field: `client.${field}`, message: `Missing required customer field: ${field}` })) };
    return { kind: 'customer', status: 'ready', draft, decisions, customer: details.client };
  }

  return { order, customer };
}
export type DraftApi = ReturnType<typeof createDraftApi>;

/** Open points as the agent reads them, in tool results and in the open request: names only, never record IDs. */
export const issuesForAgent = (issues: Issue[]) => issues.map(i => ({ field: i.field, problem: i.message, ...(i.candidates?.length ? { candidates: i.candidates.map(c => c.label) } : {}) }));

/** The part of a result the agent reads back: what to tell or ask the operator. Records stay with the application. */
export function forAgent(result: DraftResult) {
  return {
    status: result.status,
    ...(result.status === 'needs' ? { issues: issuesForAgent(result.issues) } : {}),
    note: result.status === 'needs'
      ? 'Shown to the operator with these points. Settle what you can from the conversation or a lookup and call again; ask about the rest. For a product with no match, look the catalogue up and send the product in its terms.'
      : result.status === 'existing' ? 'This customer already exists; nothing will be created.'
      : 'Complete, and shown to the operator for review.',
  };
}
