import type { OrderConnector } from './contract.js';
import { calculateLineTotals } from '../domain/totals.js';
import { preparedOrderSchema, type Client, type ClientOrder, type NewCustomer, type PreparedOrder, type Product, type SavedOrder } from '../domain/types.js';

/** Fictional in-memory service. Never contacts Fatture in Cloud. */
export class DemoConnector implements OrderConnector {
  readonly products: Product[] = [
    { id: 101, code: 'DEMO-A', name: 'Pebble hand wash 250 ml', description: '', netPrice: 12 },
    { id: 102, code: 'SAMPLE-A', name: 'Pebble hand wash 250 ml sample', description: '', netPrice: 4 },
    { id: 103, code: 'DEMO-B', name: 'Linen candle 200 g', description: '', netPrice: 20 },
    { id: 900, code: 'DELIVERY', name: 'Delivery', description: '', netPrice: 8 },
  ];
  readonly clients: Client[] = [{
    id: 201, name: 'Example Studio', country: 'IT', street: 'Example Street 1', city: 'Example City',
    postalCode: '00000', email: 'orders@example.invalid', vatNumber: 'DEMO-NOT-A-REAL-VAT', notes: '',
  }];
  readonly orders = new Map<number, PreparedOrder>();
  createCalls = 0;
  async listProducts() { return structuredClone(this.products); }
  async listClients() { return structuredClone(this.clients); }
  async createClient(input: NewCustomer) {
    const client = { ...structuredClone(input), id: 1000 + this.clients.length };
    // Listed like Fatture in Cloud lists a name-only customer: blank address fields.
    this.clients.push({ country: '', street: '', city: '', postalCode: '', ...client });
    return client;
  }
  async calculateTotals(order: PreparedOrder) { return calculateLineTotals(preparedOrderSchema.parse(order).lines); }
  async createOrder(input: PreparedOrder): Promise<SavedOrder> {
    const order = preparedOrderSchema.parse(input);
    this.createCalls++;
    const id = 100 + this.orders.size;
    this.orders.set(id, order);
    return { id, number: `DEMO-${id}` };
  }
  async updateOrder(id: number, input: PreparedOrder) {
    if (!this.orders.has(id)) throw new Error('Demo order not found');
    this.orders.set(id, preparedOrderSchema.parse(input));
    return { id, number: `DEMO-${id}` };
  }
  async listClientOrders(clientId: number, limit: number): Promise<ClientOrder[]> {
    return [...this.orders.entries()].reverse().filter(([, o]) => o.client.id === clientId).slice(0, limit).map(([id, o]) => ({
      id, number: `DEMO-${id}`, date: o.date,
      lines: o.lines.map(l => ({ productId: l.productId, code: l.code, name: l.name, quantity: l.quantity, netPrice: l.netPrice, discountPercent: l.discountPercent })),
    }));
  }
  async getOrder(id: number) {
    if (!this.orders.has(id)) throw new Error('Demo order not found');
    return { id, number: `DEMO-${id}` };
  }
}
