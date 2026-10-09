import { describe, expect, it, vi } from 'vitest';
import { FattureInCloudConnector, toFicOrder, type SdkPorts } from '../src/connector/fatture-in-cloud.js';
import { prepared } from './helpers.js';

function sdk() {
  return {
    products: { listProducts: vi.fn() },
    clients: { listClients: vi.fn(), createClient: vi.fn() },
    documents: {
      getNewIssuedDocumentTotals: vi.fn().mockResolvedValue({ data: { data: { amount_net: 29.6, amount_vat: 6.51, amount_gross: 36.11 } } }),
      createIssuedDocument: vi.fn().mockResolvedValue({ data: { data: { id: 80, type: 'order', number: 4 } } }),
      getIssuedDocument: vi.fn(), modifyIssuedDocument: vi.fn(),
    },
  };
}

describe('restricted SDK adapter', () => {
  it('creates a customer from a name alone and maps PEC to certified_email', async () => {
    const ports = sdk();
    ports.clients.createClient.mockResolvedValue({ data: { data: { id: 7, name: 'Bottega Esempio', certified_email: 'a@pec.it', address_street: '', country_iso: '' } } });
    const connector = new FattureInCloudConnector(1, ports as unknown as SdkPorts, { clientWritesEnabled: true });
    const saved = await connector.createClient({ name: 'Bottega Esempio', certifiedEmail: 'a@pec.it', notes: '' });
    expect(ports.clients.createClient.mock.calls[0]?.[1].data).toMatchObject({ name: 'Bottega Esempio', certified_email: 'a@pec.it', country: undefined });
    expect(saved).toMatchObject({ id: 7, name: 'Bottega Esempio', certifiedEmail: 'a@pec.it' });
    expect(saved.street).toBeUndefined();
  });
  it('uses preflight totals during a journaled save without another remote read', async () => {
    const ports = sdk();
    ports.documents.getNewIssuedDocumentTotals.mockRejectedValue(new Error('Read unavailable'));
    const connector = new FattureInCloudConnector(1, ports as unknown as SdkPorts, { writesEnabled: true });
    await connector.createOrder(await prepared(), { net: 29.6, vat: 6.51, gross: 36.11 });
    expect(ports.documents.getNewIssuedDocumentTotals).not.toHaveBeenCalled();
    expect(ports.documents.createIssuedDocument.mock.calls[0]?.[1].data.payments_list[0].amount).toBe(36.11);
  });
  it('rejects invoice payloads before any remote call', async () => {
    const ports = sdk();
    const connector = new FattureInCloudConnector(1, ports as unknown as SdkPorts, { writesEnabled: true });
    const order = await prepared();
    await expect(connector.createOrder({ ...order, type: 'invoice' } as unknown as typeof order)).rejects.toThrow();
    expect(ports.documents.createIssuedDocument).not.toHaveBeenCalled();
    expect(ports.documents.getNewIssuedDocumentTotals).not.toHaveBeenCalled();
  });
  it('disables live writes by default', async () => {
    const ports = sdk();
    await expect(new FattureInCloudConnector(1, ports as unknown as SdkPorts).createOrder(await prepared())).rejects.toThrow(/disabled/);
    expect(ports.documents.createIssuedDocument).not.toHaveBeenCalled();
  });
  it('builds explicit client and line data and uses authoritative totals for payment', async () => {
    const ports = sdk();
    const connector = new FattureInCloudConnector(1, ports as unknown as SdkPorts, { writesEnabled: true });
    const order = await prepared();
    expect(await connector.createOrder(order)).toEqual({ id: 80, number: '4', url: undefined });
    const payload = ports.documents.createIssuedDocument.mock.calls[0]![1].data;
    expect(payload.type).toBe('order');
    expect(payload.e_invoice).toBe(false);
    expect(payload.entity.name).toBe('Example Studio');
    expect(payload.items_list[0]).toMatchObject({ product_id: 101, net_price: 12, discount: 10, vat: { id: 1 } });
    expect(payload.payments_list[0].amount).toBe(36.11);
    expect(Object.keys(connector)).not.toContain('sdk');
  });
  it('refuses to overwrite an invoice using its document ID', async () => {
    const ports = sdk();
    ports.documents.getIssuedDocument.mockResolvedValue({ data: { data: { id: 80, type: 'invoice' } } });
    const connector = new FattureInCloudConnector(1, ports as unknown as SdkPorts, { writesEnabled: true });
    await expect(connector.updateOrder(80, await prepared())).rejects.toThrow(/forbidden/);
    expect(ports.documents.modifyIssuedDocument).not.toHaveBeenCalled();
  });
  it('retrieves all product pages and never substitutes zero for a missing price', async () => {
    const ports = sdk();
    ports.products.listProducts
      .mockResolvedValueOnce({ data: { last_page: 2, data: [{ id: 1, name: 'First', code: 'A', net_price: 2 }] } })
      .mockResolvedValueOnce({ data: { last_page: 2, data: [{ id: 2, name: 'Second', code: 'B', net_price: 3 }] } });
    const connector = new FattureInCloudConnector(1, ports as unknown as SdkPorts);
    expect((await connector.listProducts()).map(p => p.id)).toEqual([1, 2]);
    expect(ports.products.listProducts.mock.calls[1]![4]).toBe(2);
    ports.products.listProducts.mockResolvedValue({ data: { data: [{ id: 3, name: 'Missing price' }, { id: 4, name: 'Null price', net_price: null }, { id: 5, name: 'Free sample', net_price: 0 }] } });
    expect(await connector.listProducts()).toEqual([expect.objectContaining({ id: 5, netPrice: 0 })]);
  });
  it('keeps page order when later pages are fetched concurrently', async () => {
    const ports = sdk();
    ports.products.listProducts.mockImplementation(async (_c: number, _f: unknown, _s: string, _q: unknown, page: number) => {
      await new Promise(resolve => setTimeout(resolve, 7 - page));
      return { data: { last_page: 6, data: [{ id: page, name: `P${page}`, code: String(page), net_price: 1 }] } };
    });
    const connector = new FattureInCloudConnector(1, ports as unknown as SdkPorts);
    expect((await connector.listProducts()).map(p => p.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ports.products.listProducts).toHaveBeenCalledTimes(6);
  });
  it('rejects arbitrary email or unsupported document fields', async () => {
    const order = await prepared();
    expect(() => toFicOrder({ ...order, sendEmail: true } as typeof order)).toThrow();
  });
});
it('normalizes Italian country names when FIC omits country_iso', async () => {
 const ports = sdk();
 ports.clients.listClients.mockResolvedValue({data:{data:[{id:1,name:'Test',country:'Italia',address_street:'Via Test',address_city:'Roma',address_postal_code:'00100'}]}});
 const clients = await new FattureInCloudConnector(1,ports as unknown as SdkPorts).listClients();
 expect(clients[0]?.country).toBe('IT');
});
