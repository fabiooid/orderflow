import { expect, it, vi } from 'vitest';
import { LibSQLStore } from '@mastra/libsql';
import { noopObserve } from '@mastra/core/tools';
import { customerOrderHistoryTool } from '../src/assistant/customer-order-history.js';
import { createOrderAgent } from '../src/assistant/agent.js';
import { DemoConnector } from '../src/connector/demo.js';
import { config } from './helpers.js';

const client = { id: 42, name: 'Example Shop Ltd', country: 'IT', street: 'Example Street 1', city: 'Rome', postalCode: '00100', notes: '' };
const order = { id: 81, number: '12', date: '2026-09-30', lines: [
  { productId: 101, code: 'DEMO-A', name: 'Amber wash 250 ml', quantity: 3, netPrice: 12, discountPercent: 10 },
] };
const context = { observe: noopObserve };
const ports = () => ({ listClients: vi.fn(async () => [client]), listClientOrders: vi.fn(async (_id: number, _limit: number) => [order]) });

it('reads only the resolved customer and preserves historical prices separately from discounts', async () => {
  const connector = ports();
  const tool = customerOrderHistoryTool(connector);
  const result = await tool.execute!({ clientId: 42, limit: 5 }, context);
  expect(connector.listClientOrders).toHaveBeenCalledWith(42, 5);
  expect(result).toEqual({ status: 'available', client: { id: 42, name: client.name }, limit: 5, orders: [order] });
  expect(order.lines[0]).toMatchObject({ netPrice: 12, discountPercent: 10 });
});

it('distinguishes no history from API failure without leaking upstream details', async () => {
  const connector = ports();
  connector.listClientOrders.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('Authorization: secret'));
  const tool = customerOrderHistoryTool(connector);
  expect(await tool.execute!({ clientId: 42, limit: 5 }, context)).toMatchObject({ status: 'available', orders: [] });
  const unavailable = await tool.execute!({ clientId: 42, limit: 5 }, context);
  expect(unavailable).toMatchObject({ status: 'unavailable', orders: [] });
  expect(JSON.stringify(unavailable)).not.toContain('secret');
  connector.listClients.mockRejectedValueOnce(new Error('Authorization: secret'));
  expect(await tool.execute!({ clientId: 42, limit: 5 }, context)).toMatchObject({ status: 'unavailable', client: null });
});

it('does not query orders for an unknown customer', async () => {
  const connector = ports();
  const result = await customerOrderHistoryTool(connector).execute!({ clientId: 999, limit: 5 }, context);
  expect(result).toMatchObject({ status: 'client-not-found', orders: [] });
  expect(connector.listClientOrders).not.toHaveBeenCalled();
});

it('bounds history and strips unrelated account fields', async () => {
  const connector = ports();
  connector.listClientOrders.mockResolvedValue([{ ...order, url: 'https://example.invalid/private-document', entity: client } as typeof order, { ...order, id: 82 }]);
  const tool = customerOrderHistoryTool(connector);
  const result = await tool.execute!({ clientId: 42, limit: 1 }, context);
  expect(result).toMatchObject({ orders: [order] });
  expect(JSON.stringify(result)).not.toContain('private-document');
  expect(await tool.inputSchema!['~standard'].validate({ clientId: 42 })).toEqual({ value: { clientId: 42, limit: 5 } });
  expect(await tool.inputSchema!['~standard'].validate({ clientId: 42, limit: 21 })).toHaveProperty('issues');
  expect(await tool.inputSchema!['~standard'].validate({ clientId: -1 })).toHaveProperty('issues');
});

it('registers the history tool on the agent shared by Telegram and Studio without adding writes', async () => {
  const storage = new LibSQLStore({ id: 'history-tools', url: ':memory:' });
  try {
    const { agent } = createOrderAgent(config(), new DemoConnector(), storage);
    const tools = await agent.listTools();
    expect(Object.keys(tools).sort()).toEqual(['getCustomerOrderHistory', 'rememberAlias', 'searchClients', 'searchProducts']);
    expect(tools.getCustomerOrderHistory?.id).toBe('get-customer-order-history');
  } finally { await storage.close(); }
});
