import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { OrderConnector } from '../connector/contract.js';

const historyOrder = z.object({
  id: z.number().int().positive(), number: z.string(), date: z.string(),
  lines: z.array(z.object({
    productId: z.number().int().positive().optional(), code: z.string(), name: z.string(),
    quantity: z.number(), netPrice: z.number(), discountPercent: z.number(),
  })),
});

/** Only read capabilities are accepted. Historical values are evidence, not new-order defaults. */
export function customerOrderHistoryTool(connector: Pick<OrderConnector, 'listClients' | 'listClientOrders'>) {
  return createTool({
    id: 'get-customer-order-history',
    description: 'Read recent orders for a resolved customer ID, newest first: a bounded sample, not the complete history. Use for "same as last time", a product or size the customer usually takes, or a past price. Resolve the customer first; never use another customer\'s history. Cite the order number and date you rely on. History supports a specific question ("last time it was 250 ml, that one?") and settles a choice only when the referenced order and line are unambiguous. Past products may have changed: check them in the catalogue. Never copy past prices, discounts, delivery charges or VAT into a draft unless the operator asks to reuse a specific one. Unavailable history is not empty history.',
    inputSchema: z.object({ clientId: z.number().int().positive(), limit: z.number().int().min(1).max(20).default(5) }),
    outputSchema: z.object({
      status: z.enum(['available', 'client-not-found', 'unavailable']),
      client: z.object({ id: z.number().int().positive(), name: z.string() }).nullable(),
      limit: z.number().int(), orders: z.array(historyOrder),
    }),
    execute: async ({ clientId, limit }) => {
      try {
        const client = (await connector.listClients()).find(c => c.id === clientId);
        if (!client) return { status: 'client-not-found' as const, client: null, limit, orders: [] };
        const identity = { id: clientId, name: client.name };
        try {
          // Parse strips unrelated API fields (addresses, URLs, etc.) from tool output.
          const orders = z.array(historyOrder).parse(await connector.listClientOrders(clientId, limit)).slice(0, limit);
          return { status: 'available' as const, client: identity, limit, orders };
        } catch {
          return { status: 'unavailable' as const, client: identity, limit, orders: [] };
        }
      } catch {
        // Never expose raw SDK exceptions or authenticated request headers to the model.
        return { status: 'unavailable' as const, client: null, limit, orders: [] };
      }
    },
  });
}
