import { expect, it } from 'vitest';
import { conversationCases, evalConnector, northwind } from '../src/evals/conversations.js';
import { runConversation, scriptedTurns, type ScriptedAct } from '../src/evals/harness.js';
import { draftSchema, type OrderDraft } from '../src/domain/types.js';
import { orderDraftInput } from '../src/assistant/draft-schema.js';
import { systemPrompt } from '../src/assistant/system-prompt.js';
import { DemoConnector } from '../src/connector/demo.js';
import { WriteJournal } from '../src/storage/write-journal.js';
import { orderCreator } from '../src/channel/order.js';
import { TelegramController } from '../src/channel/controller.js';
import { loadConversation, TelegramStore } from '../src/channel/store.js';
import { createConversationEngine, replySchema, type Converse } from '../src/channel/engine.js';
import { LibSQLStore } from '@mastra/libsql';
import { config, message, press } from './helpers.js';

const scriptedIds = [
  'missing-combination-offers-alternatives',
  'voice-note-keeps-lines-after-customer',
  'photo-keeps-lines-and-still-asks-size',
  'customer-only-does-not-invent-lines',
  'cancelled-request-does-not-copy-lines',
  'spreadsheet-keeps-named-customer',
  'spreadsheet-create-order-persists-without-tools',
  'spreadsheet-letterhead-is-not-customer',
  'spreadsheet-header-names-customer',
  'new-file-does-not-reuse-previous-chat-customer',
  'new-order-does-not-guess-customer-or-shipping',
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

/**
 * Scripted stand-in for the model. If the notes rules are present, it writes only the requested
 * instruction (or nothing). If they are missing, it recaps the attached products, matching the live bug.
 */
function notesConverse(scenario: (typeof conversationCases)[number]): Converse {
  const draft = asOrderDraft(scenario.scripted![0]);
  const prompt = systemPrompt(config().invoicing.label);
  const notes = orderDraftInput.shape.notes.description ?? '';
  const followsRule = /notes empty unless they stated them this request/.test(prompt)
    && /Do not summarise an attached message/.test(notes)
    && /only a note the operator asked to write/.test(notes);
  return async (turn, act) => {
    const next = structuredClone(draft);
    if (!followsRule) {
      next.notes = `Prepared from attached conversation: requested 2 Pebble hand wash and 2 Linen candle. ${draft.notes}`.trim();
    }
    await act.order(next);
    return { reply: '', locale: /ship in January/i.test(turn.operatorWords) ? 'en' : 'it' };
  };
}

it.each(['requested-note-only-from-attachment', 'requested-english-note-only', 'no-note-when-not-asked'] as const)(
  'puts only the requested instruction in order notes: %s',
  async id => {
    const scenario = conversationCases.find(c => c.id === id);
    expect(scenario?.scripted).toHaveLength(1);
    const outcome = await runConversation(config(), evalConnector(), scenario!.turns, { converse: notesConverse(scenario!) });
    expect(scenario!.check(outcome)).toEqual([]);
  },
);

/**
 * Scripted stand-in for the model. If the apply-immediately rules are present, it writes the clear
 * draft edit and lets the preview speak. If they are missing, it asks whether to apply the change
 * and keep shipping, matching the live bug this case guards.
 */
function applyClearEditConverse(scenario: (typeof conversationCases)[number]): Converse {
  const drafts = scenario.scripted!;
  const prompt = systemPrompt(config().invoicing.label);
  const reply = replySchema(config().locale, config().currency).shape.reply.description ?? '';
  const followsRule = /apply a clear instruction/.test(prompt)
    && /Be concise by default/.test(prompt)
    && /let it speak for itself/.test(prompt)
    && /Do not repeat its contents or ask about missing fields it already displays/.test(prompt)
    && /let it speak for itself/.test(reply)
    && /Add text only to answer a direct question/.test(reply)
    && !/Ask about issues that still need a pick/.test(prompt)
    && !/Ask about issues that still need a pick/.test(reply);
  let turn = 0;
  return async (message, act) => {
    const next = drafts[turn++];
    const english = /Prepare an order|change the quantity|note: |delivery /i.test(message.operatorWords);
    if (turn < drafts.length) {
      await act.order(asOrderDraft(next));
      return { reply: '', locale: english ? 'en' : 'it' };
    }
    if (followsRule) {
      await act.order(asOrderDraft(next));
      return { reply: '', locale: english ? 'en' : 'it' };
    }
    await act.order(asOrderDraft(drafts[0]));
    return {
      reply: english
        ? 'Do you want me to apply that to the draft and keep shipping at 0.00? Any other changes before saving?'
        : 'Vuoi aggiungere la nota «lasciare al banco» al draft e mantenere le spese di consegna a 0,00 EUR? Vuoi apportare altre modifiche prima di salvare?',
      locale: english ? 'en' : 'it',
    };
  };
}

it.each(['apply-clear-note-on-ready-draft', 'apply-clear-quantity-on-ready-draft', 'apply-clear-shipping-on-open-draft'] as const)(
  'applies a clear draft edit immediately: %s',
  async id => {
    const scenario = conversationCases.find(c => c.id === id);
    expect(scenario?.scripted).toHaveLength(2);
    const outcome = await runConversation(config(), evalConnector(), scenario!.turns, { converse: applyClearEditConverse(scenario!) });
    expect(scenario!.check(outcome)).toEqual([]);
  },
);

/**
 * Scripted stand-in for the model. If the don't-guess customer and shipping rules are present, a
 * later unnamed file or order leaves those fields blank and lets the preview speak. If they are
 * missing, it offers the earlier chat's customer and asks to confirm a guessed delivery price.
 */
function previousChatCustomerConverse(scenario: (typeof conversationCases)[number]): Converse {
  const drafts = scenario.scripted!;
  const prompt = systemPrompt(config().invoicing.label);
  const clientQuery = orderDraftInput.shape.clientQuery.description ?? '';
  const shipping = orderDraftInput.shape.shippingPrice.description ?? '';
  const reply = replySchema(config().locale, config().currency).shape.reply.description ?? '';
  const followsRule = /leave the customer blank/.test(prompt)
    && /Do not offer, search for, confirm, use or keep a customer from earlier messages/.test(prompt)
    && /Be concise by default/.test(prompt)
    && /let it speak for itself/.test(prompt)
    && /Do not repeat its contents or ask about missing fields it already displays/.test(prompt)
    && /Empty when this request did not name a customer/.test(clientQuery)
    && /Do not send a list price, last paid, or an earlier-chat amount/.test(shipping)
    && /let it speak for itself/.test(reply)
    && /Do not repeat its contents or ask about missing fields it already displays/.test(reply)
    && !/Ask about issues that still need a pick/.test(prompt)
    && !/Ask about issues that still need a pick/.test(reply);
  let turn = 0;
  return async (_prompt, act) => {
    const next = drafts[turn++];
    if (next === 'cancel') {
      act.cancel();
      return { reply: '', locale: 'en' };
    }
    if (turn === drafts.length) {
      if (followsRule) {
        await act.order(asOrderDraft(next));
        return { reply: '', locale: 'en' };
      }
      await act.order(draftSchema.parse({ ...asOrderDraft(next), clientQuery: 'Example Studio', shippingPrice: 8 }));
      return { reply: 'Who is the customer? Confirm Example Studio from earlier, and delivery 8.00 or the list price?', locale: 'en' };
    }
    if (next) await act.order(asOrderDraft(next));
    return { reply: '', locale: 'it' };
  };
}

it.each(['new-file-does-not-reuse-previous-chat-customer', 'new-order-does-not-guess-customer-or-shipping'] as const)(
  'does not offer a previous-chat customer or shipping on %s',
  async id => {
    const scenario = conversationCases.find(c => c.id === id);
    expect(scenario?.scripted).toHaveLength(3);
    const outcome = await runConversation(config(), evalConnector(), scenario!.turns, { converse: previousChatCustomerConverse(scenario!) });
    expect(scenario!.check(outcome)).toEqual([]);
    expect(outcome.replies.at(-1)).not.toMatch(/Who is the customer\?/);
    expect(outcome.replies.at(-1)).not.toMatch(/Example Studio/);
    expect(outcome.replies.at(-1)).not.toMatch(/list price/i);
    expect(outcome.open?.draft.shippingPrice).toBeUndefined();
    expect(outcome.open?.issues?.some(i => i.field === 'client' && i.candidates?.length)).toBeFalsy();
  },
);

it('still saves with confirm-and-save after a clear note is applied to a ready draft', async () => {
  const c = config();
  c.orderSavingEnabled = true;
  c.channel.respondToAllMessages = true;
  const storage = new LibSQLStore({ id: 'note-then-save', url: ':memory:' });
  const store = new TelegramStore(':memory:', 'note-then-save');
  await store.init();
  const connector = new DemoConnector();
  const journal = new WriteJournal(':memory:');
  await journal.init();
  const scenario = conversationCases.find(c => c.id === 'apply-clear-note-on-ready-draft')!;
  const converse = applyClearEditConverse(scenario);
  let messageId = 100;
  let lastSave: string | undefined;
  const send = async (_text: string, _reply: number, keyboard?: { inline_keyboard: { callback_data: string }[][] }) => {
    lastSave = keyboard?.inline_keyboard.flat().find(b => b.callback_data.startsWith('save:'))?.callback_data;
    return { message_id: messageId++ };
  };
  try {
    const engine = createConversationEngine(c, connector, storage, { converse });
    const controller = new TelegramController(c, 'bot', store, engine, send, undefined, orderCreator(c, connector, journal), async () => ({ message_id: 200 }));
    await controller.handle(message(1, 'ordine per Example Studio: 2 Pebble hand wash 250 ml, spedizione 0 euro'));
    await controller.handle(message(2, 'nota: lasciare al banco', 100));
    const ready = await store.activeRequest();
    expect(ready?.status).toBe('ready');
    expect(ready?.draft.notes).toBe('lasciare al banco');
    expect(ready?.draft.shippingPrice).toBe(0);
    expect(lastSave).toMatch(/^save:u1:\d+$/);
    await controller.handle(press(3, lastSave!, 101));
    const saved = await store.order('u1');
    expect(saved?.status).toBe('saved');
    expect(saved?.prepared?.notes).toBe('lasciare al banco');
    expect(connector.createCalls).toBe(1);
    await engine.shutdown();
  } finally {
    store.close();
    journal.close();
    await storage.close();
  }
});

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

it('reloads stored drafts with or without a tester fact', () => {
  const base = {
    orderId: 'u1', revision: 1, status: 'suspended' as const, policy: 'test',
    draft: { clientQuery: 'Example Studio', discountPercent: 0, notes: '', lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }] },
  };
  expect(loadConversation(JSON.stringify(base)).draft.lines[0]?.tester).toBeUndefined();
  const withTester = {
    ...base,
    draft: { ...base.draft, lines: [{ query: 'SOAP250ML Pebble hand wash 250 ml tester', quantity: 1, tester: true }] },
  };
  expect(loadConversation(JSON.stringify(withTester)).draft.lines[0]).toMatchObject({ tester: true, quantity: 1 });
});

