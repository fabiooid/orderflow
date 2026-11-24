import { expect, it, vi } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { createConversationEngine } from '../src/channel/engine.js';
import { statedCustomer } from '../src/assistant/intent.js';
import { orderDraft } from '../src/channel/preview.js';
import { prepareOrder } from '../src/domain/prepare.js';
import { conversationCases, evalConnector } from '../src/evals/conversations.js';
import { runConversation } from '../src/evals/harness.js';
import { draftSchema } from '../src/domain/types.js';
import { mergeOrderDraft } from '../src/assistant/merge.js';
import type { Converse } from '../src/channel/engine.js';
import { LibSQLStore } from '@mastra/libsql';
import { RequestContext } from '@mastra/core/request-context';
import { createOrderAgent } from '../src/assistant/agent.js';
import { orderDraftInput } from '../src/assistant/draft-schema.js';
import { startTurn } from '../src/assistant/turn-context.js';
import { DemoConnector } from '../src/connector/demo.js';
import { config } from './helpers.js';

/** The change-client case: "ordine" with a fictional email whose signature names Example Studio, then "cambia il cliente". */
const changeClient = conversationCases.find(c => c.id === 'change-client-unnamed')!;
const emailText = (changeClient.turns[0] as { attachment: string }).attachment;
const emailLines = [{ query: 'Pebble hand wash 250 ml', quantity: 2 }, { query: 'Linen candle 200 g', quantity: 1 }];

/** Plays one model action per turn and records what the order API told the model. */
function playing(turns: ((act: Parameters<Converse>[1]) => Promise<string>)[], seen: unknown[] = []): Converse {
  let turn = 0;
  return async (_prompt, act) => {
    const wrapped = { ...act, order: async (draft: Parameters<typeof act.order>[0]) => { const result = await act.order(draft); seen.push(result); return result; } };
    const reply = await turns[turn++]!(wrapped);
    return { reply, locale: 'it' };
  };
}

it('takes the customer an attachment names, whatever field the model used for it', async () => {
  // The model proposes the signature's business as a new customer and copies the email's request into notes.
  const outcome = await runConversation(config(), evalConnector(), changeClient.turns.slice(0, 1), {
    converse: playing([async act => {
      await act.order(draftSchema.parse({
        newClient: { name: 'Example Studio', vatNumber: 'DEMO-NOT-A-REAL-VAT' }, lines: emailLines, notes: 'Prima possibile, con express!',
      }));
      return '';
    }]),
  });
  expect(outcome.open?.prepared?.client.id ?? outcome.open?.draft.clientId).toBe('201');
  expect(outcome.open?.draft.newClient).toBeUndefined();
  expect(outcome.open?.draft.notes).toBe('');
  expect(outcome.replies[0]).toMatch(/Example Studio/);
});

it('does not take a customer this request never names', async () => {
  const outcome = await runConversation(config(), evalConnector(), changeClient.turns.slice(0, 1), {
    converse: playing([async act => {
      await act.order(draftSchema.parse({ newClient: { name: 'Northwind Bistro' }, lines: emailLines }));
      return '';
    }]),
  });
  expect(outcome.open?.draft.clientQuery).toBe('');
  expect(outcome.open?.draft.clientId).toBeUndefined();
  expect(outcome.open?.draft.newClient).toBeUndefined();
});

it('never takes the supplier letterhead as the customer', () => {
  const draft = mergeOrderDraft({
    incoming: draftSchema.parse({ clientQuery: 'Northwind Supplies Ltd', lines: emailLines }),
    operatorWords: 'ordine',
    attachmentText: 'Letterhead (supplier, not the customer): Northwind Supplies Ltd, Harbour Lane 1\nDEMO-A | Pebble hand wash 250 ml | 2',
    isNewRequest: true,
  });
  expect(draft.clientQuery).toBe('');
});

it('keeps a note the operator asked to take from the attachment', () => {
  const draft = mergeOrderDraft({
    incoming: draftSchema.parse({ lines: emailLines, notes: 'Prima possibile, con express!' }),
    operatorWords: 'ordine, metti nella nota la richiesta del cliente',
    attachmentText: emailText,
    isNewRequest: true,
  });
  expect(draft.notes).toBe('Prima possibile, con express!');
});

it('matches products from an attachment whose turn opened no draft', async () => {
  // Turn 1: the model asks instead of opening a draft. Turn 2: it sends the email's lines with no customer.
  const outcome = await runConversation(config(), evalConnector(), changeClient.turns, {
    converse: playing([
      async () => 'Quale cliente?',
      async act => { await act.order(draftSchema.parse({ lines: emailLines })); return ''; },
    ]),
  });
  expect(outcome.open?.draft.lines.map(l => l.productId)).toEqual(['101', '103']);
  expect(outcome.replies.at(-1)).toMatch(/2 × Pebble hand wash 250 ml/);
  expect(outcome.replies.at(-1)).not.toMatch(/Pebble hand wash 250 ml[^\n]*❓/);
});

it('tells the model a blank customer and shipping are shown, not questions', async () => {
  const seen: unknown[] = [];
  await runConversation(config(), evalConnector(), [{ text: 'Prepara un ordine da questo elenco: 3 Pebble hand wash 250 ml' }], {
    converse: playing([async act => { await act.order(draftSchema.parse({ lines: [{ query: 'Pebble hand wash 250 ml', quantity: 3 }] })); return ''; }], seen),
  });
  const result = seen[0] as { status: string; issues: unknown[]; note: string };
  expect(result.status).toBe('needs');
  expect(result.issues).toEqual([]);
  expect(result.note).toMatch(/shows customer and shipping blank for the operator to fill: nothing to ask or explain/);
  expect(result.note).toMatch(/never say the draft is ready while status is needs/i);
});

it('counts agent prose that names the draft as a lead, not as the preview', () => {
  const check = conversationCases.find(c => c.id === 'new-order-unnamed-italian')!.check;
  const problems = check({
    replies: ['', '', 'Bozza ordine creata. Manca il cliente: aggiungi il nome.\n\n📝 Bozza ordine\n────\n\n🏪 ❓\n\n3 × Pebble hand wash 250 ml'],
    open: { orderId: 'x', revision: 1, status: 'suspended', draft: draftSchema.parse({ lines: [{ query: 'Pebble hand wash 250 ml', quantity: 3, productId: '101' }] }) } as never,
  });
  expect(problems.join('\n')).toMatch(/Bozza ordine creata/);
});

it('reports what the model sent to prepare-order and what it got back, for eval traces', async () => {
  const storage = new LibSQLStore({ id: 'tool-trace', url: ':memory:' });
  const calls: { tool: string; input: unknown; result: unknown }[] = [];
  try {
    const { agent } = createOrderAgent(config(), new DemoConnector(), storage, { enabled: false, rate: 0 }, {}, (tool, input, result) => calls.push({ tool, input, result }));
    const tools = await agent.listTools();
    const context = new RequestContext();
    startTurn(context, { evidence: 'ordine', operatorWords: 'ordine', senderId: '5', knownPhrases: [] });
    const input = { ...orderDraftInput.parse({
      clientQuery: '', clientId: null, newClient: { ...Object.fromEntries(Object.keys(orderDraftInput.shape.newClient.unwrap().shape).map(k => [k, null])), name: 'Example Studio' },
      manualVatCheck: null, lines: [{ query: 'Pebble hand wash 250 ml', productId: null, quantity: 2, tester: null, netPrice: null }],
      shippingPrice: null, discountPercent: 0, discountShipping: null, delivery: null, notes: '', priceTier: null,
    }) };
    await tools.prepareOrder!.execute!(input as never, { requestContext: context } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe('prepare-order');
    expect((calls[0]!.input as { newClient: { name: string } }).newClient.name).toBe('Example Studio');
    expect((calls[0]!.result as { status: string }).status).toBe('needs');
  } finally {
    await storage.close();
  }
});

it('searches a customer the model assembled from stated parts by the part a record can match', async () => {
  expect(statedCustomer('Example Studio, P.IVA DEMO-NOT-A-REAL-VAT', 'ordine', emailText)).toBe('DEMO-NOT-A-REAL-VAT');
  expect(statedCustomer('Example Studio, Northwind Bistro', 'ordine', emailText)).toBe('');
  expect(statedCustomer('Example Studio P.IVA DEMO-NOT-A-REAL-VAT', 'ordine', emailText)).toBe('DEMO-NOT-A-REAL-VAT');
  const outcome = await runConversation(config(), evalConnector(), changeClient.turns.slice(0, 1), {
    converse: playing([async act => {
      await act.order(draftSchema.parse({ clientQuery: 'Example Studio, P.IVA DEMO-NOT-A-REAL-VAT', lines: emailLines }));
      return '';
    }]),
  });
  expect(outcome.open?.prepared?.client.id ?? outcome.open?.draft.clientId).toBe('201');
});

it('drops a note the operator never asked for, however the model worded it', () => {
  const merged = (notes: string, operatorWords: string) => mergeOrderDraft({
    incoming: draftSchema.parse({ lines: emailLines, notes }), operatorWords, attachmentText: emailText, isNewRequest: true,
  }).notes;
  expect(merged('Consegna: prima possibile, con express.', 'ordine')).toBe('');
  expect(merged('Consegna entro venerdì', 'ordine, consegna entro venerdì')).toBe('Consegna entro venerdì');
});

it('takes a delivery address the request contains, typed or attached, and never one it does not', () => {
  const purchaseOrder = 'Buongiorno,\n2 x Pebble hand wash 250 ml\nConsegnare al nostro magazzino: Via Esempio 5, 00000 Example City.\nExample Studio, P.IVA DEMO-NOT-A-REAL-VAT';
  const merged = (address: string, operatorWords: string, attachmentText = purchaseOrder) => mergeOrderDraft({
    incoming: draftSchema.parse({ lines: emailLines, delivery: { address } }), operatorWords, attachmentText, isNewRequest: true,
  }).delivery?.address;
  expect(merged('Via Esempio 5, 00000 Example City', 'ordine')).toBe('Via Esempio 5, 00000 Example City');
  expect(merged('Harbour Lane 1, 00000 Example City', 'ordine')).toBeUndefined();
  expect(merged('Harbour Lane 1, 00000 Example City', 'ordine, spedisci a Harbour Lane 1', '')).toBe('Harbour Lane 1, 00000 Example City');
  expect(merged('Harbour Lane 1', 'ordine', 'Letterhead (supplier, not the customer): Northwind Supplies, Harbour Lane 1')).toBeUndefined();
  const open = mergeOrderDraft({ incoming: draftSchema.parse({ lines: emailLines, delivery: { address: 'Harbour Lane 1' } }), operatorWords: 'spedisci a Harbour Lane 1', isNewRequest: true });
  expect(mergeOrderDraft({ base: open, incoming: draftSchema.parse({ notes: '' }), operatorWords: 'spedisci a Harbour Lane 1\nok', isNewRequest: false }).delivery?.address).toBe('Harbour Lane 1');
});

it("shows the customer's own requests to the operator without saving them on the order", async () => {
  const merged = (customerRequests: string) => mergeOrderDraft({
    incoming: draftSchema.parse({ clientQuery: 'Example Studio', lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2, productId: '101' }], shippingPrice: 8, customerRequests }),
    operatorWords: 'ordine', attachmentText: emailText, isNewRequest: true,
  });
  expect(merged('Invio con corriere notturno').customerRequests).toBe('');
  const draft = merged('express, prima possibile');
  expect(draft.customerRequests).toBe('express, prima possibile');
  expect(orderDraft(draft, [], true)).toMatch(/💬 Richieste nel messaggio\nexpress, prima possibile/);
  expect(mergeOrderDraft({ base: draft, incoming: draftSchema.parse({ shippingPrice: 10 }), operatorWords: 'ordine\nspedizione 10', isNewRequest: false }).customerRequests)
    .toBe('express, prima possibile');
  // A complete order carrying the same requests: preparation builds the saved order without them.
  const prepared = await prepareOrder(draftSchema.parse({ clientId: '201', lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2, productId: '101' }], shippingPrice: 8, customerRequests: draft.customerRequests }), config(), new DemoConnector(), '2026-11-24');
  expect((prepared as { issues?: unknown }).issues ?? []).toEqual([]);
  expect(JSON.stringify(prepared.ready ? prepared.order : {})).not.toMatch(/express/);
});

it('asks the model again when it answers with nothing, then tells the operator instead of staying silent', async () => {
  const storage = new LibSQLStore({ id: 'empty-turn', url: ':memory:' });
  const empty = { object: { reply: '', locale: 'it' }, finishReason: 'stop', steps: [], text: '' };
  const generate = vi.spyOn(Agent.prototype, 'generate');
  try {
    const engine = createConversationEngine(config(), new DemoConnector(), storage);
    const input = { text: 'ordine', operatorText: 'ordine', senderId: '5', fresh: () => { throw new Error('no request expected'); } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    generate.mockResolvedValueOnce(empty as never).mockResolvedValueOnce({ object: { reply: 'Quali prodotti?', locale: 'it' } } as never);
    expect((await engine.turn(input as never)).text).toBe('Quali prodotti?');
    expect(JSON.parse(generate.mock.calls[1]![0] as string).previousAttempt).toMatch(/empty and called no tool/);
    generate.mockResolvedValueOnce(empty as never).mockResolvedValueOnce(empty as never);
    expect((await engine.turn(input as never)).text).toMatch(/Non riesco a elaborare il messaggio/);
    expect(generate).toHaveBeenCalledTimes(4);
    warn.mockRestore();
    await engine.shutdown();
  } finally {
    generate.mockRestore();
    await storage.close();
  }
});

it('judges the catalogue name on the preview, not on agent words above it', () => {
  const check = conversationCases.find(c => c.id === 'code-with-own-wording-shows-catalogue-name')!.check;
  const problems = check({
    replies: ['Bozza creata con 2 x DEMO-A sapone mani.\n\n📦 Anteprima ordine\n────\n\n🏪 Example Studio\n\n2 × Pebble hand wash 250 ml'],
    open: { orderId: 'x', revision: 1, status: 'ready', draft: draftSchema.parse({ clientQuery: 'Example Studio', clientId: '201', lines: [{ query: 'DEMO-A sapone mani', quantity: 2, productId: '101' }], shippingPrice: 8 }) } as never,
  });
  expect(problems.join('\n')).not.toMatch(/operator wording/);
});

it('asks the model again when its reply claims a draft that no tool opened, but not when it only answers', async () => {
  const storage = new LibSQLStore({ id: 'unbacked-draft', url: ':memory:' });
  const generate = vi.spyOn(Agent.prototype, 'generate');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const engine = createConversationEngine(config(), new DemoConnector(), storage);
    const input = (text: string) => ({ text, operatorText: text, senderId: '5', fresh: () => { throw new Error('no request expected'); } }) as never;
    generate.mockResolvedValueOnce({ object: { changedDraft: true, reply: 'Ho preparato la bozza.', locale: 'it' } } as never)
      .mockResolvedValueOnce({ object: { changedDraft: false, reply: 'Quali prodotti metto?', locale: 'it' } } as never);
    expect((await engine.turn(input('ordine'))).text).toBe('Quali prodotti metto?');
    expect(JSON.parse(generate.mock.calls[1]![0] as string).previousAttempt).toMatch(/called no draft tool/);
    generate.mockResolvedValueOnce({ object: { changedDraft: false, reply: 'Costa 12 EUR netti.', locale: 'it' } } as never);
    expect((await engine.turn(input('quanto costa il Pebble hand wash'))).text).toBe('Costa 12 EUR netti.');
    // A retry that claims the draft again is not shown as if it were true.
    generate.mockResolvedValueOnce({ object: { changedDraft: true, reply: 'Ho preparato la bozza.', locale: 'it' } } as never)
      .mockResolvedValueOnce({ object: { changedDraft: true, reply: 'Ecco la bozza.', locale: 'it' } } as never);
    expect((await engine.turn(input('ordine'))).text).toMatch(/Non riesco a elaborare il messaggio/);
    // A cancel is not a draft change to retry.
    generate.mockResolvedValueOnce({ object: { changedDraft: true, reply: 'Annullato.', locale: 'it' } } as never);
    expect((await engine.turn(input('lascia stare, non serve più'))).text).toBe('Annullato.');
    expect(generate).toHaveBeenCalledTimes(6);
    await engine.shutdown();
  } finally {
    warn.mockRestore();
    generate.mockRestore();
    await storage.close();
  }
});
