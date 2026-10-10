import type { AppConfig } from '../config/schema.js';
import type { OrderConnector } from '../connector/contract.js';
import { clientSchema, preparedOrderSchema, totalsSchema } from '../domain/types.js';
import { sameClient } from '../domain/matching.js';
import { PreflightFailed, type WriteJournal } from '../storage/write-journal.js';
import type { SavedOrder, Totals } from '../domain/types.js';
import { journalKey, type Conversation } from './store.js';

export function orderCreator(config: AppConfig, connector: OrderConnector, journal: WriteJournal) {
 return async (conversation: Conversation) => {
  if (!config.orderSavingEnabled || conversation.kind || !['ready','saving'].includes(conversation.status)) throw new Error('Order confirmation unavailable');
  const order = preparedOrderSchema.parse(conversation.prepared);
  const expected = totalsSchema.parse(conversation.totals);
  if (order.policyVersion !== config.policyVersion) throw new Error('Policy changed');
  const key = `${journalKey(config, conversation.orderId)}:confirmed-order`;
  // Stable key across revisions prevents a second order after an uncertain write.
  const prior = await journal.replay<SavedOrder>(key, { order, expected });
  if (prior) return prior.result;
  let actual: Totals;
  try {
   actual = await connector.calculateTotals(order);
   if ((['net','vat','gross'] as const).some(k => Math.abs(actual[k] - expected[k]) > 0.005)) throw new PreflightFailed(true);
   if (!order.client.id && !await journal.replay(`${key}:client`, order.client) && (await connector.listClients()).some(c => sameClient(c, order.client))) throw new PreflightFailed(true);
  } catch (error) { throw error instanceof PreflightFailed ? error : new PreflightFailed(); }
  return journal.once(key, {order, expected}, async () => {
   let client = order.client;
   if (!client.id) {
    client = await journal.once(`${key}:client`, client, async () => clientSchema.parse(await connector.createClient(client)));
   }
   return journal.once(`${key}:save`, {...order, client}, () => connector.createOrder({...order, client}, actual));
  });
 };
}
