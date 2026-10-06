import type { Client, PreparedOrder, Product, SavedOrder, Totals } from '../domain/types.js';

/** Orders-only capability boundary. No arbitrary HTTP, email, invoice, or delete operations. */
export interface OrderConnector {
  listProducts(): Promise<Product[]>;
  listClients(): Promise<Client[]>;
  createClient(client: Client): Promise<Client>;
  calculateTotals(order: PreparedOrder): Promise<Totals>;
  createOrder(order: PreparedOrder): Promise<SavedOrder>;
  updateOrder(id: number, order: PreparedOrder): Promise<SavedOrder>;
  getOrder(id: number): Promise<SavedOrder>;
}
