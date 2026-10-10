import { describe, expect, it } from 'vitest';
import example from '../config/example.json';
import { configSchema } from '../src/config/schema.js';
import type { OrderConnector } from '../src/connector/contract.js';
import { DemoConnector } from '../src/connector/demo.js';
import { FattureInCloudConnector, type SdkPorts } from '../src/connector/fatture-in-cloud.js';
import type { PreparedOrder } from '../src/domain/types.js';
import { config, prepared } from './helpers.js';

/**
 * Every invoicing connector must pass this suite. It uses fictional records and no network.
 * Add a new connector beside the demo and Fatture in Cloud cases.
 */
export function runConnectorContract(name: string, create: () => OrderConnector) {
  describe(`invoicing contract: ${name}`, () => {
    it('lists products, creates a customer, and lists that customer again', async () => {
      const connector = create();
      expect((await connector.listProducts()).length).toBeGreaterThan(0);
      const created = await connector.createClient({ name: 'Example Atelier', notes: '' });
      expect(created.name).toBe('Example Atelier');
      expect((await connector.listClients()).some(client => client.name === 'Example Atelier')).toBe(true);
    });

    it('saves an order, reads it back, updates it, and lists it for that customer', async () => {
      const connector = create();
      const order = await prepared();
      const totals = await connector.calculateTotals(order);
      expect(Number.isFinite(totals.net) && Number.isFinite(totals.vat) && Number.isFinite(totals.gross)).toBe(true);
      const saved = await connector.createOrder(order, totals);
      expect((await connector.getOrder(saved.id)).id).toBe(saved.id);
      expect((await connector.updateOrder(saved.id, order)).id).toBe(saved.id);
      expect((await connector.listClientOrders(order.client.id!, 5)).some(item => item.id === saved.id)).toBe(true);
    });

    it('refuses to create anything that is not an order', async () => {
      const connector = create();
      const order = await prepared();
      await expect(connector.createOrder({ ...order, type: 'invoice' } as unknown as PreparedOrder)).rejects.toThrow();
    });
  });
}

runConnectorContract('demo', () => new DemoConnector());

runConnectorContract('fatture-in-cloud', () => {
  const products = [{ id: 101, name: 'Amber hand wash 250 ml', code: 'DEMO-A', net_price: 12, description: '' }];
  const clients: Record<string, unknown>[] = [];
  const orders = new Map<number, Record<string, unknown>>();
  let nextClient = 50;
  let nextOrder = 80;
  const sdk = {
    products: { listProducts: async () => ({ data: { data: products, last_page: 1 } }) },
    clients: {
      listClients: async () => ({ data: { data: clients, last_page: 1 } }),
      createClient: async (_company: number, body: { data: Record<string, unknown> }) => {
        const saved = { ...body.data, id: nextClient++ };
        clients.push(saved);
        return { data: { data: saved } };
      },
    },
    documents: {
      getNewIssuedDocumentTotals: async () => ({ data: { data: { amount_net: 10, amount_vat: 2.2, amount_gross: 12.2 } } }),
      createIssuedDocument: async (_company: number, body: { data: Record<string, unknown> }) => {
        const id = nextOrder++;
        const saved = { ...body.data, id, type: 'order', number: id };
        orders.set(id, saved);
        return { data: { data: saved } };
      },
      getIssuedDocument: async (_company: number, id: number) => ({ data: { data: orders.get(id) } }),
      modifyIssuedDocument: async (_company: number, id: number, body: { data: Record<string, unknown> }) => {
        const saved = { ...orders.get(id), ...body.data, id, type: 'order', number: orders.get(id)?.number ?? id };
        orders.set(id, saved);
        return { data: { data: saved } };
      },
      listIssuedDocuments: async () => ({ data: { data: [...orders.values()] } }),
    },
  };
  return new FattureInCloudConnector(config().invoicing.companyId, sdk as unknown as SdkPorts, { writesEnabled: true, clientWritesEnabled: true });
});

it('still accepts a top-level companyId from older config files', () => {
  const legacy = structuredClone(example) as Record<string, unknown>;
  delete legacy.invoicing;
  legacy.companyId = 42;
  expect(configSchema.parse(legacy).invoicing).toMatchObject({ provider: 'fatture-in-cloud', companyId: 42, label: 'Fatture in Cloud' });
});
