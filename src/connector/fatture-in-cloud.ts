import {
  ClientsApi, Configuration, IssuedDocumentsApi, ProductsApi,
  type Client as FicClient, type IssuedDocument,
} from '@fattureincloud/fattureincloud-ts-sdk';
import { z } from 'zod';
import { clientSchema, preparedOrderSchema, productSchema, totalsSchema, type Client, type PreparedOrder, type SavedOrder } from '../domain/types.js';
import type { OrderConnector } from './contract.js';

export type SdkPorts = {
  products: Pick<ProductsApi, 'listProducts'>;
  clients: Pick<ClientsApi, 'listClients' | 'createClient'>;
  documents: Pick<IssuedDocumentsApi, 'createIssuedDocument' | 'modifyIssuedDocument' | 'getIssuedDocument' | 'getNewIssuedDocumentTotals'>;
};

const countryNames = new Map<string, string>();
const countryKey = (name: string) => name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
for (const locale of ['it', 'en']) {
  const names = new Intl.DisplayNames([locale], { type: 'region' });
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    const name = names.of(code);
    if (name && name !== code) countryNames.set(countryKey(name), code);
  }
}
function countryIso(client: FicClient) {
  const explicit = client.country_iso?.trim().toUpperCase();
  if (explicit && /^[A-Z]{2}$/.test(explicit)) return explicit;
  const name = client.country?.trim() ?? '';
  return countryNames.get(countryKey(name)) ?? '';
}

export function toFicClient(client: Client): FicClient {
  return {
    id: client.id, type: 'company', name: client.name, country_iso: client.country, country: new Intl.DisplayNames(['it'], { type: 'region' }).of(client.country),
    address_street: client.street, address_city: client.city, address_postal_code: client.postalCode,
    address_province: client.province, email: client.email, phone: client.phone,
    vat_number: client.vatNumber, tax_code: client.taxCode, ei_code: client.sdiCode, notes: client.notes,
  };
}

function fromFicClient(client: FicClient): Client {
  // Keep incomplete existing records searchable; preparation validates the selected record.
  return {
    id: client.id ?? undefined, name: client.name ?? '', country: countryIso(client),
    street: client.address_street ?? '', city: client.address_city ?? '', postalCode: client.address_postal_code ?? '',
    province: client.address_province || undefined, email: client.email || undefined, phone: client.phone || undefined,
    vatNumber: client.vat_number || undefined, taxCode: client.tax_code || undefined,
    sdiCode: client.ei_code || undefined, notes: client.notes ?? '',
  };
}

export function toFicOrder(input: PreparedOrder): IssuedDocument {
  const order = preparedOrderSchema.parse(input);
  return {
    type: 'order', e_invoice: false, use_gross_prices: false,
    date: order.date, entity: toFicClient(order.client), currency: { id: order.currency },
    notes: order.notes,
    payment_method: order.paymentMethodId ? { id: order.paymentMethodId } : undefined,
    items_list: order.lines.map(line => ({
      product_id: line.productId, code: line.code, name: line.name,
      qty: line.quantity, net_price: line.netPrice, discount: line.discountPercent,
      vat: { id: line.vatId },
    })),
  };
}

function saved(document: IssuedDocument | undefined): SavedOrder {
  if (!document || document.type !== 'order') throw new Error('Expected an order response; other document types are forbidden');
  return {
    id: z.number().int().positive().parse(document.id),
    number: String(document.number ?? document.id),
    url: document.url ?? undefined,
  };
}

/** Official SDK adapter; credentials and unrestricted SDK methods remain private. */
export class FattureInCloudConnector implements OrderConnector {
  readonly #companyId: number;
  readonly #sdk: SdkPorts;
  readonly #writesEnabled: boolean;
  readonly #clientWritesEnabled: boolean;

  constructor(companyId: number, sdk: SdkPorts, options: { writesEnabled?: boolean; clientWritesEnabled?: boolean } = {}) {
    this.#companyId = z.number().int().positive().parse(companyId);
    this.#sdk = sdk;
    this.#writesEnabled = options.writesEnabled ?? false;
    this.#clientWritesEnabled = options.clientWritesEnabled ?? this.#writesEnabled;
  }

  static fromToken(companyId: number, token: string, options: { writesEnabled?: boolean; clientWritesEnabled?: boolean } = {}) {
    if (!token.trim()) throw new Error('Fatture in Cloud token is required');
    const config = new Configuration({ accessToken: token, baseOptions: { timeout: 15000 } });
    return new FattureInCloudConnector(companyId, {
      clients: new ClientsApi(config), products: new ProductsApi(config), documents: new IssuedDocumentsApi(config),
    }, options);
  }

  async listProducts() {
    const products = [];
    for (let page = 1; page <= 1000; page++) {
      const response = await this.#sdk.products.listProducts(this.#companyId, undefined, 'detailed', undefined, page, 100);
      const body = response.data;
      for (const product of body.data ?? []) {
        // Description-only catalogue entries are not orderable products. Preserve explicit zero prices.
        if (product.net_price == null) continue;
        if (product.use_gross_price) throw new Error('Gross-price catalogue entries require a future pricing adapter');
        products.push(productSchema.parse({
          id: product.id, name: product.name, code: product.code ?? '', description: product.description ?? '', netPrice: product.net_price,
        }));
      }
      if (page >= (body.last_page ?? page)) return products;
    }
    throw new Error('Catalogue pagination limit reached');
  }

  async listClients() {
    const clients: Client[] = [];
    for (let page = 1; page <= 1000; page++) {
      const { data } = await this.#sdk.clients.listClients(this.#companyId, undefined, 'detailed', undefined, page, 100);
      clients.push(...(data.data ?? []).map(fromFicClient));
      if (page >= (data.last_page ?? page)) return clients;
    }
    throw new Error('Client pagination limit reached');
  }

  async createClient(input: Client) {
    if (!this.#clientWritesEnabled) throw new Error('Live client writes are disabled');
    const client = clientSchema.parse(input);
    if (client.id) throw new Error('Cannot create an existing client');
    const { data } = await this.#sdk.clients.createClient(this.#companyId, { data: toFicClient(client) });
    if (!data.data?.id) throw new Error('Client creation response missing ID; reconcile before retrying');
    return clientSchema.parse(fromFicClient(data.data));
  }

  async calculateTotals(input: PreparedOrder) {
    const { data } = await this.#sdk.documents.getNewIssuedDocumentTotals(this.#companyId, { data: toFicOrder(input) });
    return totalsSchema.parse({ net: data.data?.amount_net, vat: data.data?.amount_vat, gross: data.data?.amount_gross });
  }

  async createOrder(input: PreparedOrder) {
    this.#assertWrites();
    const order = preparedOrderSchema.parse(input);
    const totals = await this.calculateTotals(order);
    const data = toFicOrder(order);
    data.payments_list = [{ amount: totals.gross, due_date: order.dueDate, status: 'not_paid' }];
    const response = await this.#sdk.documents.createIssuedDocument(this.#companyId, { data });
    return saved(response.data.data);
  }

  async updateOrder(id: number, input: PreparedOrder) {
    this.#assertWrites();
    const order = preparedOrderSchema.parse(input);
    await this.getOrder(id); // Refuse to turn an invoice or other document into an order.
    const totals = await this.calculateTotals(order);
    const data = toFicOrder(order);
    data.payments_list = [{ amount: totals.gross, due_date: order.dueDate, status: 'not_paid' }];
    const response = await this.#sdk.documents.modifyIssuedDocument(this.#companyId, id, { data });
    return saved(response.data.data);
  }

  async getOrder(id: number) {
    z.number().int().positive().parse(id);
    const response = await this.#sdk.documents.getIssuedDocument(this.#companyId, id, undefined, 'detailed');
    return saved(response.data.data);
  }

  #assertWrites() {
    if (!this.#writesEnabled) throw new Error('Live writes are disabled; complete account readiness checks before enabling');
  }
}
