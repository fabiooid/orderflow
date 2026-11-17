import { expect, it } from 'vitest';
import { conversationCases, evalConnector } from '../src/evals/conversations.js';
import { runConversation, scriptedTurns } from '../src/evals/harness.js';
import { config } from './helpers.js';

const ids = ['missing-combination-offers-alternatives'];

it('scripts the missing-combination conversation case', () => {
  expect(ids.filter(id => conversationCases.some(c => c.id === id && c.scripted))).toEqual(ids);
});

it.each(ids)('scripted conversation: %s', async id => {
  const scenario = conversationCases.find(c => c.id === id);
  expect(scenario?.scripted).toBeTruthy();
  const outcome = await runConversation(config(), evalConnector(), scenario!.turns, { converse: scriptedTurns(scenario!.scripted!) });
  expect(scenario!.check(outcome)).toEqual([]);
});
