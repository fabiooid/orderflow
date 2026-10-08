import { expect, it } from 'vitest';
import { acceptanceCases, acceptanceScorer } from '../src/assistant/acceptance.js';

it('fails an incorrect customer even if all order lines and totals match', async () => {
  const expected = acceptanceCases[0]!.expected;
  if (!expected.ready) throw new Error('Expected a complete reference order');
  expect((await acceptanceScorer.run({ input: {}, output: expected, groundTruth: expected })).score).toBe(1);
  expect((await acceptanceScorer.run({ input: {}, output: { ...expected, clientId: 999 }, groundTruth: expected })).score).toBe(0);
  expect((await acceptanceScorer.run({ input: {}, output: expected })).score).toBe(0);
});
