import { AsyncLocalStorage } from 'node:async_hooks';
import { SpanType, type AnySpan, type ObservabilityInstance } from '@mastra/core/observability';
import type { OrderConnector } from '../connector/contract.js';

// Only context propagation lives here; Mastra owns spans, storage, export and UI.
const active = new AsyncLocalStorage<AnySpan>();
export const tracingContext = () => ({ currentSpan: active.getStore() });

export async function traceOperation<T>(name: string, action: () => Promise<T>, metadata?: Record<string, unknown>): Promise<T> {
  const parent = active.getStore();
  if (!parent) return action();
  const span = parent.createChildSpan({ type: SpanType.GENERIC, name, metadata });
  try {
    const result = await active.run(span, action);
    span.end({ output: { completed: true } });
    return result;
  } catch (error) {
    span.error({ error: new Error('Operation failed; consult durable application state before retrying'), endSpan: true });
    throw error;
  }
}

export async function traceChannelTurn<T>(instance: ObservabilityInstance | undefined, updateId: number, action: () => Promise<T>): Promise<T> {
  if (!instance) return action();
  const span = instance.startSpan({ name: 'Channel turn', type: SpanType.GENERIC, tags: ['channel', 'live'], metadata: { updateId } });
  try {
    const result = await active.run(span, action);
    // Status labels in metadata so Studio can filter turns by order and outcome.
    if (result && typeof result === 'object') {
      const { orderId, revision, state, activeOrderId, cancelled, delivered } = result as Record<string, unknown>;
      const labels = Object.fromEntries(Object.entries({ orderId, revision, state, activeOrderId, cancelled, delivered }).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)));
      if (Object.keys(labels).length) span.update({ metadata: { updateId, ...labels } });
    }
    span.end({ output: result });
    return result;
  } catch (error) {
    span.error({ error: new Error('Channel turn interrupted; inspect local write and delivery journals'), endSpan: true });
    throw error;
  }
}

/** Safe metadata only: never SDK requests/headers or PDF download URLs. */
export function tracedConnector(connector: OrderConnector): OrderConnector {
  return {
    listProducts: () => traceOperation('FIC list products', () => connector.listProducts()),
    listClients: () => traceOperation('FIC list clients', () => connector.listClients()),
    listClientOrders: (id, limit) => traceOperation('FIC customer order history', () => connector.listClientOrders(id, limit), { clientId: id }),
    calculateTotals: order => traceOperation('FIC calculate totals', () => connector.calculateTotals(order)),
    createClient: client => traceOperation('FIC create customer', () => connector.createClient(client)),
    createOrder: (order, totals) => traceOperation('FIC create order', () => connector.createOrder(order, totals), { documentType: 'order' }),
    updateOrder: (id, order) => traceOperation('FIC update order', () => connector.updateOrder(id, order), { orderId: id }),
    getOrder: id => traceOperation('FIC retrieve order PDF', () => connector.getOrder(id), { orderId: id }),
  };
}
