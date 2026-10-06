import example from '../config/example.json';
import { configSchema } from '../src/config/schema.js';
import { DemoConnector } from '../src/connector/demo.js';
import { draftSchema } from '../src/domain/types.js';
import { prepareOrder } from '../src/domain/prepare.js';
export const config = () => configSchema.parse(structuredClone(example));
export const draft = () => draftSchema.parse({
  clientQuery: 'Example Studio', lines: [{ query: 'Amber hand wash 250 ml', quantity: 2 }], shippingPrice: 8, discountPercent: 10,
});
export async function prepared() {
  const result = await prepareOrder(draft(), config(), new DemoConnector(), '2026-01-15');
  if (!result.ready) throw new Error('Fixture did not prepare');
  return result.order;
}
