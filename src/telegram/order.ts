import type { AppConfig } from '../config/schema.js';
import type { OrderConnector } from '../connector/contract.js';
import { preparedOrderSchema, totalsSchema } from '../domain/types.js';
import { sameClient } from '../domain/matching.js';
import type { WriteJournal } from '../storage/write-journal.js';
import type { Conversation } from './store.js';

export function orderCreator(config: AppConfig, connector: OrderConnector, journal: WriteJournal) {
 return async (conversation: Conversation) => {
  if (!config.orderSavingEnabled || conversation.kind || !['ready','saving'].includes(conversation.status)) throw new Error('Order confirmation unavailable');
  const order = preparedOrderSchema.parse(conversation.prepared);
  const expected = totalsSchema.parse(conversation.totals);
  if (order.policyVersion !== config.policyVersion) throw new Error('Policy changed');
  const key = `${config.deploymentId}:${config.companyId}:${config.telegram.groupId}:${conversation.orderId}:confirmed-order`;
  // Stable key across revisions prevents a second order after an uncertain write.
  return journal.once(key, {order, expected}, async () => {
   const actual = await connector.calculateTotals(order);
   if (['net','vat','gross'].some(k => Math.abs(actual[k as keyof typeof actual] - expected[k as keyof typeof expected]) > 0.005)) throw new Error('Totals changed; review required');
   let client = order.client;
   if (!client.id) {
    const duplicates = (await connector.listClients()).filter(c => sameClient(c, client));
    if (duplicates.length) throw new Error('Existing customer requires review');
    client = await journal.once(`${key}:client`, client, () => connector.createClient(client));
   }
   return journal.once(`${key}:save`, {...order, client}, () => connector.createOrder({...order, client}));
  });
 };
}
