import { expect, it } from 'vitest';
import { conversationCases, evalConnector, northwind } from '../src/evals/conversations.js';
import { runConversation, scriptedTurns, type ScriptedAct } from '../src/evals/harness.js';
import type { OrderDraft } from '../src/domain/types.js';
import { systemPrompt } from '../src/assistant/system-prompt.js';
import { DemoConnector } from '../src/connector/demo.js';
import { WriteJournal } from '../src/storage/write-journal.js';
import { orderCreator } from '../src/channel/order.js';
import { TelegramController } from '../src/channel/controller.js';
import { TelegramStore } from '../src/channel/store.js';
import { createConversationEngine, type Converse } from '../src/channel/engine.js';
import { LibSQLStore } from '@mastra/libsql';
import { config, message, press } from './helpers.js';

const scriptedIds = [
  'missing-combination-offers-alternatives',
  'voice-note-keeps-lines-after-customer',
  'photo-keeps-lines-and-still-asks-size',
  'customer-only-does-not-invent-lines',
  'cancelled-request-does-not-copy-lines',
  'spreadsheet-keeps-named-customer',
  'spreadsheet-header-names-customer',
];

function asOrderDraft(act: ScriptedAct | undefined): OrderDraft {
  if (!act || act === 'cancel') throw new Error('expected an order draft');
  return structuredClone(act);
}

it('scripts the offline conversation cases', () => {
  expect(scriptedIds.filter(id => conversationCases.some(c => c.id === id && c.scripted))).toEqual(scriptedIds);
});

it.each(scriptedIds)('scripted conversation: %s', async id => {
  const scenario = conversationCases.find(c => c.id === id);
  expect(scenario?.scripted).toBeTruthy();
  const outcome = await runConversation(config(), evalConnector(), scenario!.turns, { converse: scriptedTurns(scenario!.scripted!) });
  expect(scenario!.check(outcome)).toEqual([]);
});


/**
 * Scripted stand-in for the model. It follows the written conversation rules: if they say a short
 * customer name on a ready draft is a new search, it searches; if they do not, it asks to save as-is,
 * matching the live bug this case guards.
 */
function correctionConverse(scenario: (typeof conversationCases)[number]): Converse {
  const drafts = scenario.scripted!;
  const followsRule = /short customer name/.test(systemPrompt(config().invoicing.label))
    && /not a request to save/.test(systemPrompt(config().invoicing.label));
  return async (prompt, act) => {
    if (!prompt.openRequest) {
      await act.order(asOrderDraft(drafts[0]));
      return { reply: '', locale: 'it' };
    }
    const readyWithCustomer = prompt.openRequest.status === 'ready'
      && !!(prompt.openRequest.draft.clientId || prompt.openRequest.draft.clientQuery.trim());
    const saveWords = /\b(salva|conferma e salva|confirm and save|save this|save the order)\b/i.test(prompt.operatorWords);
    const changeWords = /\b(cambia(?:re)? il cliente|change (?:the )?(?:customer|client))\b/i.test(prompt.operatorWords);
    const shortName = prompt.operatorWords.trim().split(/\s+/).length <= 4 && !saveWords;
    if (readyWithCustomer && (shortName || changeWords) && !saveWords) {
      if (!followsRule) return { reply: 'Vuoi salvare l\'ordine così com\'è per Example Studio?', locale: 'it' };
      await act.order(asOrderDraft(drafts[1]));
      return { reply: '', locale: 'it' };
    }
    await act.order(structuredClone(prompt.openRequest.draft));
    return { reply: '', locale: 'it' };
  };
}

it.each(['short-name-on-ready-draft-is-new-search', 'change-customer-on-ready-draft'] as const)(
  'treats %s as a customer search on a ready draft, not a save',
  async id => {
    const scenario = conversationCases.find(c => c.id === id);
    expect(scenario?.scripted).toHaveLength(2);
    const outcome = await runConversation(config(), evalConnector(), scenario!.turns, { converse: correctionConverse(scenario!) });
    expect(scenario!.check(outcome)).toEqual([]);
    expect(outcome.open?.status).not.toBe('saved');
  },
);

it('still saves when the operator presses confirm-and-save on a ready draft', async () => {
  const c = config();
  c.orderSavingEnabled = true;
  c.channel.respondToAllMessages = true;
  const storage = new LibSQLStore({ id: 'ready-save', url: ':memory:' });
  const store = new TelegramStore(':memory:', 'ready-save');
  await store.init();
  const connector = new DemoConnector();
  const journal = new WriteJournal(':memory:');
  await journal.init();
  const scenario = conversationCases.find(c => c.id === 'short-name-on-ready-draft-is-new-search')!;
  const converse: Converse = async (_prompt, act) => {
    await act.order(asOrderDraft(scenario.scripted![0]));
    return { reply: '', locale: 'it' };
  };
  let messageId = 100;
  const send = async (_text: string, _reply: number, keyboard?: { inline_keyboard: { callback_data: string }[][] }) => {
    lastSave = keyboard?.inline_keyboard.flat().find(b => b.callback_data.startsWith('save:'))?.callback_data;
    return { message_id: messageId++ };
  };
  let lastSave: string | undefined;
  try {
    const engine = createConversationEngine(c, connector, storage, { converse });
    const controller = new TelegramController(c, 'bot', store, engine, send, undefined, orderCreator(c, connector, journal), async () => ({ message_id: 200 }));
    await controller.handle(message(1, 'ordine per Example Studio: 2 Pebble hand wash 250 ml, spedizione 8 euro'));
    const ready = await store.activeRequest();
    expect(ready?.status).toBe('ready');
    expect(ready?.prepared?.client.id ?? ready?.draft.clientId).toBe('201');
    expect(lastSave).toMatch(/^save:u1:\d+$/);
    await controller.handle(press(2, lastSave!, 100));
    const saved = await store.order('u1');
    expect(saved?.status).toBe('saved');
    expect(saved?.prepared?.client.id ?? saved?.draft.clientId).toBe('201');
    expect(connector.createCalls).toBe(1);
    expect(saved?.savedOrder?.id).toBeTruthy();
    await engine.shutdown();
  } finally {
    store.close();
    journal.close();
    await storage.close();
  }
});

it('updates the customer from a short name and still allows confirm-and-save afterwards', async () => {
  const c = config();
  c.orderSavingEnabled = true;
  c.channel.respondToAllMessages = true;
  const storage = new LibSQLStore({ id: 'correct-then-save', url: ':memory:' });
  const store = new TelegramStore(':memory:', 'correct-then-save');
  await store.init();
  const connector = evalConnector();
  const journal = new WriteJournal(':memory:');
  await journal.init();
  const scenario = conversationCases.find(c => c.id === 'short-name-on-ready-draft-is-new-search')!;
  const converse = correctionConverse(scenario);
  let messageId = 100;
  let lastSave: string | undefined;
  let lastPick: string | undefined;
  const send = async (_text: string, _reply: number, keyboard?: { inline_keyboard: { text: string; callback_data: string }[][] }) => {
    const buttons = keyboard?.inline_keyboard.flat() ?? [];
    lastSave = buttons.find(b => b.callback_data.startsWith('save:'))?.callback_data;
    lastPick = buttons.find(b => b.callback_data.includes(`:client:${northwind.id}`))?.callback_data;
    return { message_id: messageId++ };
  };
  try {
    const engine = createConversationEngine(c, connector, storage, { converse });
    const controller = new TelegramController(c, 'bot', store, engine, send, undefined, orderCreator(c, connector, journal), async () => ({ message_id: 200 }));
    await controller.handle(message(1, 'ordine per Example Studio: 2 Pebble hand wash 250 ml, spedizione 8 euro'));
    await controller.handle(message(2, 'Northwind', 100));
    const asked = await store.activeRequest();
    expect(asked?.prepared?.client.id ?? asked?.draft.clientId).not.toBe('201');
    expect(asked?.status).not.toBe('saved');
    expect(asked?.status).toBe('suspended');
    expect(asked?.issues?.some(i => i.field === 'client' && i.candidates?.some(c => c.id === northwind.id))).toBe(true);
    expect(connector.createCalls).toBe(0);
    expect(lastPick).toMatch(new RegExp(`^pick:u1:\\d+:client:${northwind.id}$`));
    await controller.handle(press(3, lastPick!, 101));
    const corrected = await store.activeRequest();
    expect(corrected?.prepared?.client.id ?? corrected?.draft.clientId).toBe(northwind.id);
    expect(corrected?.status).toBe('ready');
    expect(lastSave).toMatch(/^save:u1:\d+$/);
    await controller.handle(press(4, lastSave!, 102));
    expect((await store.order('u1'))?.status).toBe('saved');
    expect(connector.createCalls).toBe(1);
    expect((await store.order('u1'))?.prepared?.client.id).toBe(northwind.id);
    await engine.shutdown();
  } finally {
    store.close();
    journal.close();
    await storage.close();
  }
});

