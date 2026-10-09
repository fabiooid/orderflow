import {
  ClientsApi, Configuration, IssuedDocumentsApi, ProductsApi,
  type Client as FicClient, type IssuedDocument,
} from '@fattureincloud/fattureincloud-ts-sdk';
import { z } from 'zod';
import { newCustomerSchema, preparedOrderSchema, productSchema, totalsSchema, type Client, type ClientOrder, type NewCustomer, type PreparedOrder, type Product, type SavedOrder, type Totals } from '../domain/types.js';
import type { OrderConnector } from './contract.js';

export type SdkPorts = {
  products: Pick<ProductsApi, 'listProducts'>;
  clients: Pick<ClientsApi, 'listClients' | 'createClient'>;
  documents: Pick<IssuedDocumentsApi, 'createIssuedDocument' | 'modifyIssuedDocument' | 'getIssuedDocument' | 'getNewIssuedDocumentTotals' | 'listIssuedDocuments'>;
};

const positiveId = z.number().int().positive();
const italianRegions = new Intl.DisplayNames(['it'], { type: 'region' });
const countryNames = new Map<string, string>();
const countryKey = (name: string) => name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
for (const locale of ['it', 'en']) {
  const names = locale === 'it' ? italianRegions : new Intl.DisplayNames([locale], { type: 'region' });
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

export function toFicClient(client: NewCustomer): FicClient {
  return {
    id: client.id, type: 'company', name: client.name, country_iso: client.country, country: client.country ? italianRegions.of(client.country) : undefined,
    address_street: client.street, address_city: client.city, address_postal_code: client.postalCode,
    address_province: client.province, email: client.email, certified_email: client.certifiedEmail, phone: client.phone,
    vat_number: client.vatNumber, tax_code: client.taxCode, ei_code: client.sdiCode, notes: client.notes,
  };
}

function fromFicClient(client: FicClient): Client {
  // Keep incomplete existing records searchable; preparation validates the selected record.
  return {
    id: client.id ?? undefined, name: client.name ?? '', country: countryIso(client),
    street: client.address_street ?? '', city: client.address_city ?? '', postalCode: client.address_postal_code ?? '',
    province: client.address_province || undefined, email: client.email || undefined, certifiedEmail: client.certified_email || undefined, phone: client.phone || undefined,
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
    id: positiveId.parse(document.id),
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
    this.#companyId = positiveId.parse(companyId);
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

  listProducts(): Promise<Product[]> {
    return this.#paginate('Catalogue', async page => (await this.#sdk.products.listProducts(this.#companyId, undefined, 'detailed', undefined, page, 100)).data, product => {
      // Description-only catalogue entries are not orderable products. Preserve explicit zero prices.
      if (product.net_price == null) return undefined;
      if (product.use_gross_price) throw new Error('Gross-price catalogue entries require a future pricing adapter');
      return productSchema.parse({
        id: product.id, name: product.name, code: product.code ?? '', description: product.description ?? '', netPrice: product.net_price,
      });
    });
  }

  listClients(): Promise<Client[]> {
    return this.#paginate('Client', async page => (await this.#sdk.clients.listClients(this.#companyId, undefined, 'detailed', undefined, page, 100)).data, fromFicClient);
  }

  async createClient(input: NewCustomer) {
    if (!this.#clientWritesEnabled) throw new Error('Live client writes are disabled');
    const client = newCustomerSchema.parse(input);
    if (client.id) throw new Error('Cannot create an existing client');
    const { data } = await this.#sdk.clients.createClient(this.#companyId, { data: toFicClient(client) });
    if (!data.data?.id) throw new Error('Client creation response missing ID; reconcile before retrying');
    // A name-only customer comes back with blank address fields, which mean absent rather than invalid.
    return newCustomerSchema.parse(Object.fromEntries(Object.entries(fromFicClient(data.data)).filter(([key, value]) => value !== '' || key === 'notes')));
  }

  async calculateTotals(input: PreparedOrder) {
    const { data } = await this.#sdk.documents.getNewIssuedDocumentTotals(this.#companyId, { data: toFicOrder(input) });
    return totalsSchema.parse({ net: data.data?.amount_net, vat: data.data?.amount_vat, gross: data.data?.amount_gross });
  }

  async createOrder(input: PreparedOrder, validatedTotals?: Totals) {
    this.#assertWrites();
    const data = await this.#orderPayload(preparedOrderSchema.parse(input), validatedTotals);
    const response = await this.#sdk.documents.createIssuedDocument(this.#companyId, { data });
    return saved(response.data.data);
  }

  async updateOrder(id: number, input: PreparedOrder) {
    this.#assertWrites();
    const order = preparedOrderSchema.parse(input);
    await this.getOrder(id); // Refuse to turn an invoice or other document into an order.
    const data = await this.#orderPayload(order);
    const response = await this.#sdk.documents.modifyIssuedDocument(this.#companyId, id, { data });
    return saved(response.data.data);
  }

  async getOrder(id: number) {
    positiveId.parse(id);
    const response = await this.#sdk.documents.getIssuedDocument(this.#companyId, id, undefined, 'detailed');
    return saved(response.data.data);
  }

  /** Read-only recovery check. Fail closed if the remote document differs from the confirmed payload. */
  async verifySavedOrder(id: number, expected: PreparedOrder, totals: Totals): Promise<SavedOrder> {
    positiveId.parse(id);
    const remote = (await this.#sdk.documents.getIssuedDocument(this.#companyId, id, undefined, 'detailed')).data.data;
    const result = saved(remote);
    const wanted = toFicOrder(expected);
    const same = (a: unknown, b: unknown) => (a ?? '') === (b ?? '');
    const entityFields = ['name', 'address_street', 'address_city', 'address_postal_code', 'vat_number'] as const;
    const lines = remote?.items_list ?? [];
    if (!remote || remote.e_invoice || remote.use_gross_prices || remote.date !== wanted.date || remote.currency?.id !== wanted.currency?.id
      || !same(remote.notes, wanted.notes) || !remote.entity || countryIso(remote.entity) !== expected.client.country
      || (expected.client.id !== undefined && remote.entity.id !== expected.client.id)
      || entityFields.some(field => !same(remote.entity?.[field], wanted.entity?.[field]))
      || lines.length !== expected.lines.length
      || lines.some((line, i) => { const target = expected.lines[i]!; return line.product_id !== target.productId || line.qty !== target.quantity || line.net_price !== target.netPrice || (line.discount ?? 0) !== target.discountPercent || line.vat?.id !== target.vatId; })
      || remote.amount_net !== totals.net || remote.amount_vat !== totals.vat || remote.amount_gross !== totals.gross
      || !same(remote.payment_method?.id, expected.paymentMethodId)
      || remote.payments_list?.length !== 1 || remote.payments_list[0]?.due_date !== expected.dueDate || remote.payments_list[0]?.amount !== totals.gross) throw new Error('Remote order differs from the confirmed order; manual investigation required');
    return result;
  }

  async listClientOrders(clientId: number, limit: number): Promise<ClientOrder[]> {
    positiveId.parse(clientId);
    // The API accepts 5 to 100 results per page.
    const { data } = await this.#sdk.documents.listIssuedDocuments(this.#companyId, 'order', undefined, 'detailed', '-date', 1, Math.min(100, Math.max(5, limit)), `entity.id = ${clientId}`);
    return (data.data ?? []).filter(d => d.type === 'order' && d.entity?.id === clientId).slice(0, limit).map(d => ({
      id: positiveId.parse(d.id), number: String(d.number ?? d.id), date: d.date ?? '',
      lines: (d.items_list ?? []).map(i => ({
        productId: i.product_id ?? undefined, code: i.code ?? '', name: i.name ?? '',
        quantity: i.qty ?? 0, netPrice: i.net_price ?? 0, discountPercent: i.discount ?? 0,
      })),
    }));
  }

  async #orderPayload(order: PreparedOrder, validatedTotals?: Totals) {
    const totals = validatedTotals ? totalsSchema.parse(validatedTotals) : await this.calculateTotals(order);
    const data = toFicOrder(order);
    data.payments_list = [{ amount: totals.gross, due_date: order.dueDate, status: 'not_paid' }];
    return data;
  }

  async #paginate<T, R>(label: string, fetchPage: (page: number) => Promise<{ data?: T[] | null; last_page?: number | null }>, map: (item: T) => R | undefined) {
    const first = await fetchPage(1);
    const last = first.last_page ?? 1;
    if (last > 1000) throw new Error(`${label} pagination limit reached`);
    // The first page gives the page count; fetch the rest a few at a time, well within API rate limits.
    const bodies: { data?: T[] | null }[] = [first];
    for (let start = 2; start <= last; start += 4) {
      const pages = Array.from({ length: Math.min(4, last - start + 1) }, (_, i) => start + i);
      bodies.push(...await Promise.all(pages.map(fetchPage)));
    }
    return bodies.flatMap(body => (body.data ?? []).map(map).filter((mapped): mapped is R => mapped !== undefined));
  }

  #assertWrites() {
    if (!this.#writesEnabled) throw new Error('Live writes are disabled; complete account readiness checks before enabling');
  }
}
