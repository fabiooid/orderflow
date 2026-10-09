import type { OrderConnector } from '../connector/contract.js';
import { clientSchema, preparedOrderSchema, type PreparedOrder } from '../domain/types.js';
import type { WriteJournal } from '../storage/write-journal.js';

/** Call only with a completed preparation result and a stable application-owned operation key. */
export async function savePreparedOrder(key: string, input: PreparedOrder, connector: OrderConnector, journal: WriteJournal) {
  let order = preparedOrderSchema.parse(input);
  if (!order.client.id) {
    const client = await journal.once(`${key}:client`, order.client, async () => clientSchema.parse(await connector.createClient(order.client)));
    order = { ...order, client };
  }
  return journal.once(`${key}:order`, order, () => connector.createOrder(order));
}
