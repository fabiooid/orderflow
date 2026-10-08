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
    description: 'Read recent orders for a resolved customer ID, newest first. Use for "same as last time", product/size ambiguity, or historical price comparisons. Resolve the customer with searchClients first when needed. Historical prices and discounts are not current defaults. Empty available history differs from unavailable history.',
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
