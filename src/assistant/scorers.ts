import { createScorer } from '@mastra/core/evals';
import { z } from 'zod';
import { totalsSchema } from '../domain/types.js';

const observedSchema = z.object({
  productIds: z.array(z.number()), quantities: z.array(z.number()), totals: totalsSchema,
});
/** A deterministic Mastra scorer; no judge-model spend for exact order fields. */
export const exactOrderScorer = createScorer({
  id: 'exact-order', description: 'Exact products, quantities, and monetary totals against a reference order',
  type: { input: observedSchema, output: observedSchema },
}).generateScore(({ run }) => {
  const expected = run.input;
  const actual = run.output;
  if (!expected) return 0;
  const equalArray = (a: number[], b: number[]) => a.length === b.length && a.every((n, i) => n === b[i]);
  return equalArray(expected.productIds, actual.productIds) && equalArray(expected.quantities, actual.quantities)
    && expected.totals.net === actual.totals.net && expected.totals.vat === actual.totals.vat && expected.totals.gross === actual.totals.gross ? 1 : 0;
});
