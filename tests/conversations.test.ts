import { expect, it } from 'vitest';
import { conversationCases, evalConnector } from '../src/evals/conversations.js';
import { runConversation, scriptedTurns } from '../src/evals/harness.js';
import { config } from './helpers.js';

const ids = ['voice-note-keeps-lines-after-customer', 'photo-keeps-lines-and-still-asks-size', 'customer-only-does-not-invent-lines', 'cancelled-request-does-not-copy-lines'];

it('scripts the FAB-49 conversation cases', () => {
  expect(ids.filter(id => conversationCases.some(c => c.id === id && c.scripted))).toEqual(ids);
});

it.each(ids)('scripted conversation: %s', async id => {
  const scenario = conversationCases.find(c => c.id === id);
  expect(scenario?.scripted).toBeTruthy();
  const outcome = await runConversation(config(), evalConnector(), scenario!.turns, { converse: scriptedTurns(scenario!.scripted!) });
  expect(scenario!.check(outcome)).toEqual([]);
});
