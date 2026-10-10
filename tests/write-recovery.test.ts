import { expect, it, vi } from 'vitest';
import { WriteJournal } from '../src/storage/write-journal.js';
import { DemoConnector } from '../src/connector/demo.js';
import { FattureInCloudConnector, toFicClient, toFicOrder, type SdkPorts } from '../src/connector/fatture-in-cloud.js';
import { orderCreator } from '../src/channel/order.js';
import { config, prepared, draft } from './helpers.js';
import { journalKey, type Conversation } from '../src/channel/store.js';

it('reconciles a confirmed remote result without repeating the write, and refuses mismatched payloads', async () => {
  const journal = new WriteJournal(':memory:'); await journal.init();
  try {
    const action = vi.fn(async () => { throw new Error('timeout'); });
    await expect(journal.once('order', { quantity: 2 }, action)).rejects.toThrow();
    await expect(journal.resolve('order', { quantity: 3 }, { id: 7 }, 'Verified remote order 7')).rejects.toThrow('payload');
    await journal.resolve('order', { quantity: 2 }, { id: 7 }, 'Verified remote order 7');
    expect(await journal.once('order', { quantity: 2 }, action)).toEqual({ id: 7 });
    expect(action).toHaveBeenCalledTimes(1);
    await expect(journal.approveRetry('order', 'Verified no record exists')).rejects.toThrow('completed');
  } finally { journal.close(); }
});

it('retains a completed customer when an explicitly approved absent order is retried', async () => {
  const c = config(); c.orderSavingEnabled = true;
  const connector = new DemoConnector();
  const order = await prepared(); delete order.client.id; order.client.name = 'Fictional new business'; order.client.vatNumber = 'ANOTHER-FICTIONAL-VAT';
  const totals = await connector.calculateTotals(order);
  const conversation: Conversation = { orderId: 'recovery', revision: 1, status: 'ready', draft: draft(), prepared: order, totals, policy: '' };
  const journal = new WriteJournal(':memory:'); await journal.init();
  const create = vi.spyOn(connector, 'createOrder').mockRejectedValueOnce(new Error('timeout before remote save'));
  const customer = vi.spyOn(connector, 'createClient');
  try {
    const save = orderCreator(c, connector, journal);
    await expect(save(conversation)).rejects.toThrow();
    const key = `${journalKey(c, conversation.orderId)}:confirmed-order`;
    await journal.approveRetry(key, 'Operator checked FIC: customer exists, no order was created');
    expect(await save(conversation)).toHaveProperty('id');
    expect(customer).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(await save(conversation)).toHaveProperty('id');
    expect(create).toHaveBeenCalledTimes(2);
  } finally { journal.close(); }
});

it('validates the full remote order before offering found-record recovery', async () => {
  const order = await prepared();
  const totals = await new DemoConnector().calculateTotals(order);
  const document = { ...toFicOrder(order), id: 91, number: 5, entity: toFicClient(order.client), amount_net: totals.net, amount_vat: totals.vat, amount_gross: totals.gross, payments_list: [{ amount: totals.gross, due_date: order.dueDate }] };
  const read = vi.fn(async () => ({ data: { data: document } }));
  const connector = new FattureInCloudConnector(1, { documents: { getIssuedDocument: read } } as unknown as SdkPorts);
  expect(await connector.verifySavedOrder('91', order, totals)).toMatchObject({ id: '91' });
  document.items_list![0]!.qty = 99;
  await expect(connector.verifySavedOrder('91', order, totals)).rejects.toThrow('differs');
  document.type = 'invoice';
  await expect(connector.verifySavedOrder('91', order, totals)).rejects.toThrow('forbidden');
});
