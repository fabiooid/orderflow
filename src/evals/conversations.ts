import { DemoConnector } from '../connector/demo.js';
import { expect, type ConversationCase, type ConversationOutcome } from './harness.js';

/** A second fictional customer, so a case can move an order away from the one named in an attachment. */
export const northwind = {
  id: 202, name: 'Northwind Bistro', country: 'IT', street: 'Via Nord 5', city: 'Bergamo', postalCode: '24100',
  email: 'orders@northwind.invalid', vatNumber: 'DEMO-NORTHWIND', notes: '',
};
/** The fictional catalogue plus a second customer and a second size, so cases can change customer or pick a size. */
export function evalConnector() {
  const connector = new DemoConnector();
  connector.clients.push(structuredClone(northwind));
  connector.products.push({ id: 104, code: 'DEMO-A5', name: 'Amber hand wash 500 ml', description: '', netPrice: 20 });
  // Italian words in a description, as a real catalogue has, so Italian questions can find the English-named candle.
  connector.products.find(p => p.id === 103)!.description = 'Candela profumata al lino';
  return connector;
}

/** An email screenshot from a customer contact, like the ones operators forward into the group. */
const email = `Da: Anna Rossi <anna@example-studio.invalid> 08:46
A: me

Grazie Christian.
Prima possibile, con express!

2 x Amber hand wash 250 ml
1 x Linen candle 200 g

Example Studio
Example Street 1, Example City
P.IVA DEMO-NOT-A-REAL-VAT`;

/** Replies the application sends when it gave up rather than understood. */
const giveUps = [/Non riesco a elaborare/i, /Unable to process this message/i, /Non sono riuscito ad applicare/i, /could not apply that choice/i];

type Check = (o: ConversationOutcome) => string[];
const last = (o: ConversationOutcome) => o.replies.at(-1) ?? '';
const neverGaveUp: Check = o => o.replies.flatMap(reply => expect(!giveUps.some(p => p.test(reply)), `gave up: ${reply.split('\n')[0]}`));
const keptAttachmentLines: Check = o => expect(!!o.open?.draft.lines.some(l => l.productId === 101 || /amber/i.test(l.query)), 'the attachment lines were lost');
const orderFor = (id: number): Check => o => [
  ...expect(o.open?.draft.clientId === id, `client is ${o.open?.draft.clientId ?? `"${o.open?.draft.clientQuery ?? 'none'}"`}, expected ${id}`),
  ...expect(!o.open?.draft.newClient, `proposes creating new customer "${o.open?.draft.newClient?.name}"`),
];
/** A question, or a request phrased as an instruction ("dimmi il cliente"): a keyword heuristic, not a judge. */
const lastAsks: Check = o => expect(/\?|\b(?:dimmi|indica|indicami|specifica|quale|tell me|which|specify)\b/i.test(last(o)), 'the last reply asks nothing');
const nothingOpen: Check = o => expect(!o.open, `request ${o.open?.orderId} is still open (${o.open?.status})`);
const all = (...checks: Check[]): Check => o => checks.flatMap(check => check(o));
// Notes and delivery are the agent's judgement, shown in the draft for the operator to keep or change, so they are not checked.
const attachmentOrderFor = (id: number) => all(neverGaveUp, keptAttachmentLines, orderFor(id));

/** The operator names a different customer than the attached email, in various wordings: the email still gives the lines. */
const otherCustomerCases: ConversationCase[] = [
  ['caption-names-other-client', [{ text: 'Crea ordine ma per cliente Northwind Bistro', attachment: email }]],
  ['caption-client-label', [{ text: 'Crea ordine, Cliente: Northwind Bistro', attachment: email }]],
  ['correct-client-after-attachment', [{ text: 'ordine per Northwind Bistro', attachment: email }, { text: 'Il cliente è Northwind Bistro' }]],
  ['prepare-this-but-change-client', [{ text: 'ordine', attachment: email }, { text: 'prepare this order but change the client to Northwind Bistro' }]],
].map(([id, turns]) => ({ id: id as string, turns: turns as ConversationCase['turns'], check: attachmentOrderFor(northwind.id) }));

export const conversationCases: ConversationCase[] = [
  // Name and VAT number in the email match one existing customer: no identity question, no new customer.
  { id: 'attachment-names-known-client', turns: [{ text: 'ordine', attachment: email }], check: attachmentOrderFor(201) },
  ...otherCustomerCases,
  {
    id: 'change-client-unnamed',
    turns: [{ text: 'ordine', attachment: email }, { text: 'prepara questo ordine ma cambia il cliente' }],
    // Nothing names the new customer: the agent asks which one, keeping the lines.
    check: all(neverGaveUp, keptAttachmentLines, lastAsks),
  },
  { id: 'cancel-in-words', turns: [{ text: 'ordine', attachment: email }, { text: 'lascia stare, non serve più' }], check: all(neverGaveUp, nothingOpen) },
  {
    id: 'create-customer-then-edit',
    turns: [{ text: 'Crea un nuovo cliente: Bottega Verde srl, Via Roma 1, 24100 Bergamo, Italia, P.IVA IT01234567890' }, { text: 'aggiungi la mail info@bottegaverde.invalid' }],
    check: all(neverGaveUp, o => [
      ...expect(o.open?.kind === 'customer' && o.open.status === 'ready', `expected a customer ready to confirm, got ${o.open?.kind ?? 'order'} ${o.open?.status ?? 'none'}`),
      ...expect(/bottega verde/i.test(o.open?.draft.newClient?.name ?? ''), 'customer name lost'),
      ...expect(o.open?.draft.newClient?.email === 'info@bottegaverde.invalid', 'email not added'),
    ]),
  },
  {
    id: 'customer-already-exists',
    turns: [{ text: 'crea il cliente Northwind Bistro' }],
    check: all(neverGaveUp, o => expect(!(o.open?.kind === 'customer' && o.open.status === 'ready'), 'offers to create a duplicate of Northwind Bistro')),
  },
  {
    id: 'pick-size-with-button',
    turns: [{ text: 'ordine per Example Studio: 2 amber hand wash, spedizione 8 euro' }, { press: '500 ml' }],
    check: all(neverGaveUp, orderFor(201), o => expect(o.open?.status === 'ready' && !!o.open.prepared?.lines.some(l => l.productId === 104 && l.quantity === 2), `expected a ready order with 2 × 500 ml, got ${o.open?.status ?? 'none'}`)),
  },
  {
    id: 'price-correction',
    turns: [{ text: 'ordine per Example Studio: 2 Amber hand wash 250 ml, spedizione 8 euro' }, { text: 'metti il prezzo a 10 euro' }],
    check: all(neverGaveUp, o => expect(!!o.open?.prepared?.lines.some(l => l.productId === 101 && l.netPrice === 10), 'the 10 euro price was not applied')),
  },
  {
    id: 'catalogue-question-mid-order',
    turns: [{ text: 'ordine per Example Studio: 2 Amber hand wash 250 ml, spedizione 8 euro' }, { text: 'che candele avete?' }],
    check: all(neverGaveUp, o => [
      ...expect(last(o).includes('Linen candle'), 'the candle question was not answered'),
      ...expect(o.open?.status === 'ready' && o.open.draft.lines.length === 1, 'the open order changed'),
    ]),
  },
  {
    id: 'short-follow-up',
    turns: [{ text: 'che candele abbiamo?' }, { text: 'crea ordine con 20' }],
    // "20" refers to the candles just discussed: a draft with them, not a question about which product.
    check: all(neverGaveUp, o => expect(!!o.open?.draft.lines.some(l => (l.productId === 103 || /linen candle/i.test(l.query)) && l.quantity === 20),
      `expected a draft with 20 Linen candles, got ${o.open ? JSON.stringify(o.open.draft.lines) : 'no request'}`)),
  },
  {
    id: 'customer-then-order',
    turns: [{ text: 'Crea cliente: Marcello Bello Via Pippo 5, 24050 Popolone BG' }, { text: 'ok crea ordine' }, { text: '2 Amber hand wash 250 ml, spedizione 8 euro' }],
    // The country follows from the address; the order replaces the customer just drafted, with nothing to cancel first.
    check: all(neverGaveUp, o => [
      ...expect(!!o.open && o.open.kind !== 'customer' && o.open.draft.newClient?.name === 'Marcello Bello', `expected an order for the new customer Marcello Bello, got ${o.open?.kind ?? 'order'} for ${o.open?.draft.newClient?.name ?? o.open?.draft.clientQuery ?? 'nobody'}`),
      ...expect(o.open?.draft.newClient?.country === 'IT', 'country not inferred from the Italian address'),
      ...expect(!o.replies.some(r => /Nessuna richiesta aperta|annullarla/i.test(r)), 'asked to cancel the customer request first'),
    ]),
  },
  {
    id: 'no-copied-template',
    turns: [{ text: 'crea cliente Marcello Bello, Via Pippo 5, 24050 Popolone BG' }, { press: 'Annulla' }, { text: 'crea cliente Pippo Pippolini Via Pluto 3, 24040 Casazza BG' }],
    // With a draft already in the history, the agent must not write one into its own reply: the template shows once.
    check: all(neverGaveUp, o => expect((last(o).match(/👤 Nuovo cliente/g)?.length ?? 0) === 1, 'the draft template appears more than once, or not at all')),
  },
  {
    id: 'show-the-order',
    turns: [{ text: 'ordine per Example Studio: 2 Amber hand wash 250 ml' }, { text: 'che tempo fa domani?' }, { text: 'ok mostrami l\'ordine' }],
    check: all(neverGaveUp, orderFor(201), o => expect(/Bozza ordine|Anteprima ordine/.test(last(o)), 'the open order was not shown')),
  },
  { id: 'off-topic', turns: [{ text: 'che tempo fa domani a Milano?' }], check: all(neverGaveUp, nothingOpen, o => expect(last(o).length < 300, 'long off-topic reply')) },
  {
    id: 'new-order-starts-empty',
    turns: [{ text: 'crea cliente Pippo Pippolini Via Pluto 3, 24040 Casazza BG' }, { press: 'Annulla' }, { text: 'what type of candles do we have?' }, { text: 'add 20 to a new order' }],
    // The candles were just discussed; the cancelled customer was not, so the new order has no customer and the reply is English.
    check: all(neverGaveUp, o => [
      ...expect(!!o.open?.draft.lines.some(l => (l.productId === 103 || /linen candle/i.test(l.query)) && l.quantity === 20), 'expected 20 Linen candles'),
      ...expect(!o.open?.draft.newClient && !o.open?.draft.clientId && !/pippo/i.test(o.open?.draft.clientQuery ?? ''), `took a customer from an earlier request: ${o.open?.draft.newClient?.name ?? o.open?.draft.clientQuery}`),
      ...expect(last(o).includes('Draft order'), 'not in English'),
    ]),
  },
  {
    id: 'english-request',
    turns: [{ text: 'Prepare an order for Northwind Bistro: 3 Linen candle 200 g, delivery 8 euros' }],
    check: all(neverGaveUp, orderFor(northwind.id), o => expect(last(o).includes('📦 Order preview'), 'no English order preview')),
  },
];
