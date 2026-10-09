import { AsyncLocalStorage } from 'node:async_hooks';
import type { OrderConnector } from './contract.js';

type Lists = { products?: Promise<unknown>; clients?: Promise<unknown> };
const turn = new AsyncLocalStorage<Lists>();

/**
 * One catalogue and client read per Telegram turn: routing tools, identity resolution and preparation otherwise each
 * re-list everything (several seconds per list). Outside `withTurnCache` every call reads fresh, and save preflight
 * uses its own uncached connector, so a write never relies on these lists.
 */
export function turnCachedConnector(connector: OrderConnector): OrderConnector & { prefetch: () => void } {
  const cached = <T>(key: keyof Lists, read: () => Promise<T>) => async (): Promise<T> => {
    const lists = turn.getStore();
    if (!lists) return read();
    const pending = (lists[key] ??= read().catch(error => { lists[key] = undefined; throw error; })) as Promise<T>;
    // Callers own their copy, so one caller's edits never leak into another's view of the turn.
    return structuredClone(await pending);
  };
  const listProducts = cached('products', () => connector.listProducts());
  const listClients = cached('clients', () => connector.listClients());
  return {
    /** Starts this turn's reads in the background, so they overlap the first model call instead of following it. */
    prefetch: () => { if (turn.getStore()) for (const list of [listProducts, listClients]) list().catch(() => undefined); },
    listProducts, listClients,
    listClientOrders: (id, limit) => connector.listClientOrders(id, limit),
    calculateTotals: order => connector.calculateTotals(order),
    createClient: client => connector.createClient(client),
    createOrder: (order, totals) => connector.createOrder(order, totals),
    updateOrder: (id, order) => connector.updateOrder(id, order),
    getOrder: id => connector.getOrder(id),
  };
}

export const withTurnCache = <T>(action: () => Promise<T>) => turn.run({}, action);
