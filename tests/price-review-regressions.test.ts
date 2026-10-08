import { expect, it, vi } from 'vitest';
import { config, draft } from './helpers.js';
import { DemoConnector } from '../src/connector/demo.js';
import { searchCatalogue } from '../src/domain/matching.js';
import { prepareOrder } from '../src/domain/prepare.js';

it('honors exact tester SKUs in search and preparation without suggesting testers for ordinary names', async () => {
  const connector = new DemoConnector();
  const tester = { id: 999, code: 'SAMPLE-T', name: 'TESTER Amber wash', description: '', netPrice: 7 };
  const products = [...await connector.listProducts(), tester];
  vi.spyOn(connector, 'listProducts').mockResolvedValue(products);
  expect(searchCatalogue('SAMPLE-T', products)).toEqual([tester]);
  expect(searchCatalogue('Amber wash', products)).not.toContainEqual(tester);
  const result = await prepareOrder({ ...draft(), lines: [{ query: 'SAMPLE-T', productId: 999, quantity: 1 }] }, config(), connector, '2026-10-07');
  expect(result.ready).toBe(true);
  if (result.ready) expect(result.order.lines[0]?.productId).toBe(999);
});

