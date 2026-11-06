import { expect, it } from 'vitest';
import { acceptanceCases, exactOutcome, observedOutcome } from '../src/evals/acceptance.js';
import { runConversation, scriptedTurns } from '../src/evals/harness.js';
import { DemoConnector } from '../src/connector/demo.js';
import { draftSchema } from '../src/domain/types.js';
import { config, prepared } from './helpers.js';

it('fails an incorrect customer even if all order lines and totals match', async () => {
  const order = await prepared();
  const request = { orderId: 'a', revision: 1, status: 'ready' as const, draft: draftSchema.parse({}), policy: '', prepared: order, totals: { net: 29.6, vat: 6.51, gross: 36.11 } };
  const expected = observedOutcome(request);
  expect(exactOutcome(expected)({ replies: [], open: request })).toEqual([]);
  expect(exactOutcome({ ...expected, clientId: '999' } as typeof expected)({ replies: [], open: request })).toHaveLength(1);
  expect(exactOutcome(expected)({ replies: [] })).toHaveLength(1);
});

it('shows the catalogue name after a form-style line is already matched', async () => {
  const scenario = acceptanceCases.find(c => c.id === 'form-line-shows-catalogue');
  expect(scenario?.scripted).toBeTruthy();
  const outcome = await runConversation(config(), new DemoConnector(), scenario!.turns, { converse: scriptedTurns(scenario!.scripted!) });
  expect(scenario!.check(outcome)).toEqual([]);
});
