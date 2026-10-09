import type { Client, ClientOrder, NewCustomer, PreparedOrder, Product, SavedOrder, Totals } from '../domain/types.js';

/** Orders-only capability boundary. No arbitrary HTTP, email, invoice, or delete operations. */
export interface OrderConnector {
  listProducts(): Promise<Product[]>;
  listClients(): Promise<Client[]>;
  /** Only the name is required; an order's caller parses the result as a complete Client. */
  createClient(client: NewCustomer): Promise<NewCustomer>;
  calculateTotals(order: PreparedOrder): Promise<Totals>;
  /** Pass totals already obtained from calculateTotals to avoid a read inside a journaled write. */
  createOrder(order: PreparedOrder, validatedTotals?: Totals): Promise<SavedOrder>;
  updateOrder(id: number, order: PreparedOrder): Promise<SavedOrder>;
  getOrder(id: number): Promise<SavedOrder>;
  /** Most recent orders of one client, newest first. Read-only. */
  listClientOrders(clientId: number, limit: number): Promise<ClientOrder[]>;
}
