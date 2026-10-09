import { expect, it } from 'vitest';
import { exactOutcome, observedOutcome } from '../src/evals/acceptance.js';
import { draftSchema } from '../src/domain/types.js';
import { prepared } from './helpers.js';

it('fails an incorrect customer even if all order lines and totals match', async () => {
  const order = await prepared();
  const request = { orderId: 'a', revision: 1, status: 'ready' as const, draft: draftSchema.parse({}), policy: '', prepared: order, totals: { net: 29.6, vat: 6.51, gross: 36.11 } };
  const expected = observedOutcome(request);
  expect(exactOutcome(expected)({ replies: [], open: request })).toEqual([]);
  expect(exactOutcome({ ...expected, clientId: 999 } as typeof expected)({ replies: [], open: request })).toHaveLength(1);
  expect(exactOutcome(expected)({ replies: [] })).toHaveLength(1);
});
