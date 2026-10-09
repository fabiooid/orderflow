import { describe, expect, it, vi } from 'vitest';
import { DemoConnector } from '../src/connector/demo.js';
import { turnCachedConnector, withTurnCache } from '../src/connector/turn-cache.js';

describe('turn cache', () => {
  it('lists once per turn, fresh across turns and outside one', async () => {
    const demo = new DemoConnector();
    const products = vi.spyOn(demo, 'listProducts');
    const clients = vi.spyOn(demo, 'listClients');
    const connector = turnCachedConnector(demo);
    await withTurnCache(async () => {
      await Promise.all([connector.listProducts(), connector.listProducts(), connector.listClients()]);
      await connector.listProducts();
    });
    expect(products).toHaveBeenCalledTimes(1);
    expect(clients).toHaveBeenCalledTimes(1);
    await withTurnCache(() => connector.listProducts());
    await connector.listProducts();
    expect(products).toHaveBeenCalledTimes(3);
  });
  it('prefetches into the turn, and never outside one', async () => {
    const demo = new DemoConnector();
    const products = vi.spyOn(demo, 'listProducts');
    const clients = vi.spyOn(demo, 'listClients');
    const connector = turnCachedConnector(demo);
    connector.prefetch();
    expect(products).not.toHaveBeenCalled();
    await withTurnCache(async () => {
      connector.prefetch();
      expect(products).toHaveBeenCalledTimes(1);
      await Promise.all([connector.listProducts(), connector.listClients()]);
    });
    expect(products).toHaveBeenCalledTimes(1);
    expect(clients).toHaveBeenCalledTimes(1);
  });
  it('gives each caller its own copy and retries a failed read', async () => {
    const demo = new DemoConnector();
    const products = vi.spyOn(demo, 'listProducts').mockRejectedValueOnce(new Error('down'));
    const connector = turnCachedConnector(demo);
    await withTurnCache(async () => {
      await expect(connector.listProducts()).rejects.toThrow('down');
      const first = await connector.listProducts();
      first[0]!.name = 'changed';
      expect((await connector.listProducts())[0]!.name).not.toBe('changed');
    });
    expect(products).toHaveBeenCalledTimes(2);
  });
});
