import { DemoConnector } from '../connector/demo.js';
import { draftSchema } from '../domain/types.js';
import { expect, type ConversationCase, type ConversationOutcome } from './harness.js';

/** A second fictional customer, so a case can move an order away from the one named in an attachment. */
export const northwind = {
  id: '202', name: 'Northwind Bistro', country: 'IT', street: 'Via Nord 5', city: 'Bergamo', postalCode: '24100',
  email: 'orders@northwind.invalid', vatNumber: 'DEMO-NORTHWIND', notes: '',
};
/** A fictional account whose legal name is longer than the everyday word an operator might type. */
export const maplePine = {
  id: '401', name: 'Maple & Pine Trading Ltd', country: 'IT', street: 'Harbour Lane 12', city: 'Example City',
  postalCode: '00000', email: 'orders@maple-pine.invalid', vatNumber: 'DEMO-MAPLE-PINE', notes: '',
};
/** The fictional catalogue plus a second customer and a second size, so cases can change customer or pick a size. */
export function evalConnector() {
  const connector = new DemoConnector();
  connector.clients.push(structuredClone(northwind), structuredClone(maplePine));
  connector.products.push({ id: '104', code: 'DEMO-A5', name: 'Pebble hand wash 500 ml', description: '', netPrice: 20 });
  // A requested fig hand soap does not exist; fig shower gel and cedar hand soap do.
  connector.products.push(
    { id: '105', code: 'DEMO-FIG-GEL', name: 'Fig shower gel 250 ml', description: '', netPrice: 14 },
    { id: '106', code: 'DEMO-CEDAR-SOAP', name: 'Cedar hand soap 250 ml', description: '', netPrice: 12 },
  );
  // Italian words in a description, as a real catalogue has, so Italian questions can find the English-named candle.
  connector.products.find(p => p.id === '103')!.description = 'Candela profumata al lino';
  return connector;
}

/** An email screenshot from a customer contact, like the ones operators forward into the group. */
const email = `Da: Anna Rossi <anna@example-studio.invalid> 08:46
A: me

Grazie mille.
Prima possibile, con express!

2 x Pebble hand wash 250 ml
1 x Linen candle 200 g

Example Studio
Example Street 1, Example City
P.IVA DEMO-NOT-A-REAL-VAT`;

/** Replies the application sends when it gave up rather than understood. */
const giveUps = [/Non riesco a elaborare/i, /Unable to process this message/i, /Non sono riuscito ad applicare/i, /could not apply that choice/i];

type Check = (o: ConversationOutcome) => string[];
const last = (o: ConversationOutcome) => o.replies.at(-1) ?? '';
const neverGaveUp: Check = o => o.replies.flatMap(reply => expect(!giveUps.some(p => p.test(reply)), `gave up: ${reply.split('\n')[0]}`));
const keptAttachmentLines: Check = o => expect(!!o.open?.draft.lines.some(l => l.productId === '101' || /pebble/i.test(l.query)), 'the attachment lines were lost');
const orderFor = (id: string): Check => o => [
  ...expect(o.open?.draft.clientId === id, `client is ${o.open?.draft.clientId ?? `"${o.open?.draft.clientQuery ?? 'none'}"`}, expected ${id}`),
  ...expect(!o.open?.draft.newClient, `proposes creating new customer "${o.open?.draft.newClient?.name}"`),
];
/** Offline matching may leave the name on the draft without a locked id. */
const namedFor = (id: string, name: RegExp): Check => o => [
  ...expect(o.open?.draft.clientId === id || name.test(o.open?.draft.clientQuery ?? ''), `client is ${o.open?.draft.clientId ?? `"${o.open?.draft.clientQuery ?? 'none'}"`}, expected ${id}`),
  ...expect(!o.open?.draft.newClient, `proposes creating new customer "${o.open?.draft.newClient?.name}"`),
];
/** A question, or a request phrased as an instruction ("dimmi il cliente"): a keyword heuristic, not a judge. */
const lastAsks: Check = o => expect(/\?|\b(?:dimmi|indica|indicami|specifica|quale|tell me|which|specify)\b/i.test(last(o)), 'the last reply asks nothing');
const nothingOpen: Check = o => expect(!o.open, `request ${o.open?.orderId} is still open (${o.open?.status})`);
const all = (...checks: Check[]): Check => o => checks.flatMap(check => check(o));
/** A ready Example Studio order, so a later short name can be a customer correction rather than a first search. */
const readyExampleDraft = () => draftSchema.parse({
  clientQuery: 'Example Studio', lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }], shippingPrice: 8,
});
/** Same lines, new customer query, no locked id: the application searches again and must not save. */
const northwindCorrectionDraft = () => draftSchema.parse({
  clientQuery: 'Northwind', lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }], shippingPrice: 8,
});
const askedToSaveAsIs = (o: ConversationOutcome) => /vuoi salvare|salv[aeio].{0,60}cos[iì]|save (?:the |this )?(?:order |draft )?as-?is|want me to save/i.test(o.replies.join('\n'));
const notSavedAsIs: Check = o => [
  ...expect(!askedToSaveAsIs(o), `asked to save the current draft as-is: ${(last(o) || '').split('\n')[0]}`),
  ...expect(o.open?.status !== 'saved' && o.open?.status !== 'saving', `saved without confirm-and-save (${o.open?.status ?? 'none'})`),
];
const keptReadyLines: Check = o => expect(!!o.open?.draft.lines.some(l => l.productId === '101' || /pebble/i.test(l.query)), 'the order lines were lost');
/** Ready draft, then a short name or change request: lock or ask, never keep the previous account or ask to save as-is. */
const switchedCustomer = (id: string, name: RegExp): Check => o => {
  const locked = o.open?.draft.clientId === id || o.open?.prepared?.client.id === id;
  const named = name.test(o.open?.draft.clientQuery ?? '');
  const picking = !!o.open?.issues?.some(i => i.field === 'client' && i.candidates?.some(c => name.test(c.label)));
  return [
    ...expect(locked || named || picking, `client is ${o.open?.prepared?.client.id ?? o.open?.draft.clientId ?? `"${o.open?.draft.clientQuery ?? 'none'}"`}, expected ${id}`),
    ...expect(!o.open?.draft.newClient, `proposes creating new customer "${o.open?.draft.newClient?.name}"`),
    ...expect(o.open?.prepared?.client.id !== '201', `kept the previous account ${o.open?.prepared?.client.id}`),
  ];
};
const readyCustomerCorrection = all(neverGaveUp, keptReadyLines, switchedCustomer(northwind.id, /northwind/i), notSavedAsIs);
// Customer identity from an attachment is checked; leftover recap notes are not, except in the dedicated FAB-56 cases below.
const attachmentOrderFor = (id: string) => all(neverGaveUp, keptAttachmentLines, orderFor(id));
const recapNote = /Prepared from attached conversation/i;
/** The printed note is only the instruction the operator asked for, in their language, with no recap of the draft. */
const onlyRequestedNote = (expected: string): Check => o => {
  const notes = o.open?.draft.notes ?? '';
  return [
    ...expect(notes === expected, `notes were ${JSON.stringify(notes)}, expected ${JSON.stringify(expected)}`),
    ...expect(!recapNote.test(notes), `notes recapped an attached message: ${JSON.stringify(notes)}`),
    ...expect(!/pebble|hand wash|linen candle/i.test(notes), `notes repeated product lines: ${JSON.stringify(notes)}`),
  ];
};
const notesStayEmpty: Check = o => {
  const notes = o.open?.draft.notes ?? '';
  return [
    ...expect(!notes.trim(), `wrote a note nobody asked for: ${JSON.stringify(notes)}`),
    ...expect(!recapNote.test(notes), `notes recapped an attached message: ${JSON.stringify(notes)}`),
  ];
};

/** The operator names a different customer than the attached email, in various wordings: the email still gives the lines. */
const otherCustomerCases: ConversationCase[] = [
  ['caption-names-other-client', [{ text: 'Crea ordine ma per cliente Northwind Bistro', attachment: email }]],
  ['caption-client-label', [{ text: 'Crea ordine, Cliente: Northwind Bistro', attachment: email }]],
  ['correct-client-after-attachment', [{ text: 'ordine per Northwind Bistro', attachment: email }, { text: 'Il cliente è Northwind Bistro' }]],
  ['prepare-this-but-change-client', [{ text: 'ordine', attachment: email }, { text: 'prepare this order but change the client to Northwind Bistro' }]],
].map(([id, turns]) => ({ id: id as string, turns: turns as ConversationCase['turns'], check: attachmentOrderFor(northwind.id) }));

export const conversationCases: ConversationCase[] = [
  // Name and VAT number in the email match one existing customer: no identity question, no new customer.
  { id: 'attachment-names-known-client', turns: [{ text: 'ordine', attachment: email }], check: attachmentOrderFor('201') },
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
    turns: [{ text: 'Crea un nuovo cliente: Fable Goods srl, Via Roma 1, 24100 Bergamo, Italia, P.IVA IT01234567890' }, { text: 'aggiungi la mail info@fablegoods.invalid' }],
    check: all(neverGaveUp, o => [
      ...expect(o.open?.kind === 'customer' && o.open.status === 'ready', `expected a customer ready to confirm, got ${o.open?.kind ?? 'order'} ${o.open?.status ?? 'none'}`),
      ...expect(/fable goods/i.test(o.open?.draft.newClient?.name ?? ''), 'customer name lost'),
      ...expect(o.open?.draft.newClient?.email === 'info@fablegoods.invalid', 'email not added'),
    ]),
  },
  {
    id: 'customer-already-exists',
    turns: [{ text: 'crea il cliente Northwind Bistro' }],
    check: all(neverGaveUp, o => expect(!(o.open?.kind === 'customer' && o.open.status === 'ready'), 'offers to create a duplicate of Northwind Bistro')),
  },
  {
    id: 'pick-size-with-button',
    turns: [{ text: 'ordine per Example Studio: 2 pebble hand wash, spedizione 8 euro' }, { press: '500 ml' }],
    check: all(neverGaveUp, orderFor('201'), o => expect(o.open?.status === 'ready' && !!o.open.prepared?.lines.some(l => l.productId === '104' && l.quantity === 2), `expected a ready order with 2 × 500 ml, got ${o.open?.status ?? 'none'}`)),
  },
  {
    id: 'price-correction',
    turns: [{ text: 'ordine per Example Studio: 2 Pebble hand wash 250 ml, spedizione 8 euro' }, { text: 'metti il prezzo a 10 euro' }],
    check: all(neverGaveUp, o => expect(!!o.open?.prepared?.lines.some(l => l.productId === '101' && l.netPrice === 10), 'the 10 euro price was not applied')),
  },
  {
    id: 'catalogue-question-mid-order',
    turns: [{ text: 'ordine per Example Studio: 2 Pebble hand wash 250 ml, spedizione 8 euro' }, { text: 'che candele avete?' }],
    check: all(neverGaveUp, o => [
      ...expect(last(o).includes('Linen candle'), 'the candle question was not answered'),
      ...expect(o.open?.status === 'ready' && o.open.draft.lines.length === 1, 'the open order changed'),
    ]),
  },
  {
    id: 'short-follow-up',
    turns: [{ text: 'che candele abbiamo?' }, { text: 'crea ordine con 20' }],
    // "20" refers to the candles just discussed: a draft with them, not a question about which product.
    check: all(neverGaveUp, o => expect(!!o.open?.draft.lines.some(l => (l.productId === '103' || /linen candle/i.test(l.query)) && l.quantity === 20),
      `expected a draft with 20 Linen candles, got ${o.open ? JSON.stringify(o.open.draft.lines) : 'no request'}`)),
  },
  {
    id: 'customer-then-order',
    turns: [{ text: 'Crea cliente: Marco Esempio Via Esempio 5, 24100 Bergamo BG' }, { text: 'ok crea ordine' }, { text: '2 Pebble hand wash 250 ml, spedizione 8 euro' }],
    // The country follows from the address; the order replaces the customer just drafted, with nothing to cancel first.
    check: all(neverGaveUp, o => [
      ...expect(!!o.open && o.open.kind !== 'customer' && o.open.draft.newClient?.name === 'Marco Esempio', `expected an order for the new customer Marco Esempio, got ${o.open?.kind ?? 'order'} for ${o.open?.draft.newClient?.name ?? o.open?.draft.clientQuery ?? 'nobody'}`),
      ...expect(o.open?.draft.newClient?.country === 'IT', 'country not inferred from the Italian address'),
      ...expect(!o.replies.some(r => /Nessuna richiesta aperta|annullarla/i.test(r)), 'asked to cancel the customer request first'),
    ]),
  },
  {
    id: 'no-copied-template',
    turns: [{ text: 'crea cliente Marco Esempio, Via Esempio 5, 24100 Bergamo BG' }, { press: 'Annulla' }, { text: 'crea cliente Luca Esempio Via Esempio 3, 24100 Bergamo BG' }],
    // With a draft already in the history, the agent must not write one into its own reply: the template shows once.
    check: all(neverGaveUp, o => expect((last(o).match(/👤 Nuovo cliente/g)?.length ?? 0) === 1, 'the draft template appears more than once, or not at all')),
  },
  {
    id: 'show-the-order',
    turns: [{ text: 'ordine per Example Studio: 2 Pebble hand wash 250 ml' }, { text: 'che tempo fa domani?' }, { text: 'ok mostrami l\'ordine' }],
    check: all(neverGaveUp, orderFor('201'), o => expect(/Bozza ordine|Anteprima ordine/.test(last(o)), 'the open order was not shown')),
  },
  // The catalogue says "hand wash"; the operator says "saponi". Meaning, not shared words, finds it.
  { id: 'soap-by-meaning', turns: [{ text: 'abbiamo saponi?' }], check: all(neverGaveUp, o => expect(/hand wash/i.test(last(o)), 'the hand wash was not offered for "saponi"')) },
  { id: 'whole-catalogue', turns: [{ text: 'che prodotti abbiamo?' }], check: all(neverGaveUp, o => expect(['hand wash', 'Linen candle'].every(name => last(o).includes(name)), 'the catalogue was not listed')) },
  {
    id: 'soap-in-an-order',
    turns: [{ text: 'ordine per Example Studio: 2 saponi, spedizione 8 euro' }],
    // The hand wash, chosen or offered (two sizes fit): never "no product", and never unrelated products.
    check: all(neverGaveUp, o => {
      const chosen = ['101', '104'].includes(o.open?.draft.lines[0]?.productId ?? '');
      const offered = /hand wash/i.test(last(o)) || !!o.open?.issues?.some(i => i.field === 'lines.0' && i.candidates?.some(c => /hand wash/i.test(c.label)));
      return [...expect(chosen || offered, `"saponi" did not lead to the hand wash: ${JSON.stringify(o.open?.draft.lines)}`), ...expect(!/Linen candle/.test(last(o)), 'offered unrelated products')];
    }),
  },
  {
    id: 'no-invented-delivery',
    turns: [{ text: 'abbiamo saponi?' }, { text: 'ok mettili in un ordine 4 saponi e un tester cliente Example Studio' }],
    // Prices were just shown, but nobody named a delivery charge: it stays open for the order API to ask.
    check: all(neverGaveUp, o => expect(o.open?.draft.shippingPrice === undefined, `invented a delivery charge of ${o.open?.draft.shippingPrice}`)),
  },
  { id: 'off-topic', turns: [{ text: 'che tempo fa domani a Milano?' }], check: all(neverGaveUp, nothingOpen, o => expect(last(o).length < 300, 'long off-topic reply')) },
  {
    id: 'new-order-starts-empty',
    turns: [{ text: 'crea cliente Luca Esempio Via Esempio 3, 24100 Bergamo BG' }, { press: 'Annulla' }, { text: 'what type of candles do we have?' }, { text: 'add 20 to a new order' }],
    // The candles were just discussed; the cancelled customer was not, so the new order has no customer and the reply is English.
    check: all(neverGaveUp, o => [
      ...expect(!!o.open?.draft.lines.some(l => (l.productId === '103' || /linen candle/i.test(l.query)) && l.quantity === 20), 'expected 20 Linen candles'),
      ...expect(!o.open?.draft.newClient && !o.open?.draft.clientId && !/pippo/i.test(o.open?.draft.clientQuery ?? ''), `took a customer from an earlier request: ${o.open?.draft.newClient?.name ?? o.open?.draft.clientQuery}`),
      ...expect(last(o).includes('Draft order'), 'not in English'),
    ]),
  },
  {
    id: 'customer-only-does-not-invent-lines',
    turns: [{ text: 'che saponi abbiamo?' }, { text: 'crea un nuovo ordine per Northwind Bistro' }],
    // Naming only a customer after a product-rich thread: lock that customer, leave lines empty, ask what to add.
    // Offline: the second draft omits lines, as FAB-39 guards leftover conversation memory.
    scripted: [null, draftSchema.parse({ clientQuery: 'Northwind Bistro' })],
    check: all(neverGaveUp, namedFor(northwind.id, /northwind bistro/i), o => [
      ...expect(!o.open?.draft.lines.length, `invented lines from the earlier catalogue answer: ${JSON.stringify(o.open?.draft.lines)}`),
      ...expect(!!o.open?.issues?.some(i => i.field === 'lines'), 'did not ask for products on the empty draft'),
    ]),
  },
  {
    id: 'spreadsheet-keeps-named-customer',
    // A filled sheet with a blank customer header must keep the customer already named in chat (FAB-55).
    // The second scripted draft sends only the extracted lines, as a blank form header would.
    turns: [
      { text: 'crea un nuovo ordine per Example Studio' },
      { text: 'aggiungi questo', attachment: 'SKU-100 | Hand cream 100 ml | Qty: 2\nSKU-250 | Room spray 250 ml | tester: 1' },
    ],
    scripted: [
      draftSchema.parse({ clientQuery: 'Example Studio' }),
      draftSchema.parse({ lines: [
        { query: 'Hand cream 100 ml SKU-100', quantity: 2 },
        { query: 'Room spray 250 ml SKU-250 tester', quantity: 1 },
      ] }),
    ],
    check: all(neverGaveUp, namedFor('201', /example studio/i), o => [
      ...expect(!!o.open?.draft.lines.some(l => /SKU-100|hand cream/i.test(l.query) && l.quantity === 2), 'the filled cream line was lost'),
      ...expect(!!o.open?.draft.lines.some(l => /tester/i.test(l.query) && /SKU-250|room spray/i.test(l.query)), 'the tester line was lost'),
      ...expect(o.open?.status !== 'saved' && o.open?.status !== 'saving', `saved without confirm (${o.open?.status ?? 'none'})`),
    ]),
  },
  {
    id: 'spreadsheet-header-names-customer',
    turns: [{ text: 'ordine', attachment: 'Header: Customer: Northwind Bistro\nSKU-100 | Hand cream 100 ml | Qty: 2' }],
    scripted: [draftSchema.parse({
      clientQuery: 'Northwind Bistro',
      lines: [{ query: 'Hand cream 100 ml SKU-100', quantity: 2 }],
    })],
    check: all(neverGaveUp, namedFor(northwind.id, /northwind/i), o => [
      ...expect(!!o.open?.draft.lines.some(l => /SKU-100|hand cream/i.test(l.query)), 'the filled spreadsheet line was lost'),
      ...expect(o.open?.status !== 'saved' && o.open?.status !== 'saving', `saved without confirm (${o.open?.status ?? 'none'})`),
    ]),
  },
  {
    id: 'voice-note-keeps-lines-after-customer',
    // Voice note already listed the products; the later customer lock must not wipe them (FAB-49).
    // The second scripted draft drops the lines, as the live bug did when the customer was resolved.
    turns: [
      { text: '', voice: 'Due Pebble hand wash 250 ml e una Linen candle 200 g, spedizione 8 euro' },
      { text: 'cliente Northwind Bistro' },
    ],
    scripted: [
      draftSchema.parse({ lines: [
        { query: 'Pebble hand wash 250 ml', quantity: 2 },
        { query: 'Linen candle 200 g', quantity: 1 },
      ] }),
      draftSchema.parse({ clientQuery: 'Northwind Bistro' }),
    ],
    check: all(neverGaveUp, namedFor(northwind.id, /northwind bistro/i), o => [
      ...expect(!!o.open?.draft.lines.some(l => l.productId === '101' || /pebble/i.test(l.query)), 'the voice-note hand wash was lost'),
      ...expect(!!o.open?.draft.lines.some(l => l.productId === '103' || /linen candle/i.test(l.query)), 'the voice-note candle was lost'),
      ...expect(!o.open?.issues?.some(i => i.field === 'lines'), 'asked to restate products already on the draft'),
      ...expect(o.open?.draft.shippingPrice === undefined, `changed shipping behaviour: ${o.open?.draft.shippingPrice}`),
      ...expect(!!o.open?.issues?.some(i => i.field === 'shippingPrice'), 'stopped asking for shipping'),
    ]),
  },
  {
    id: 'photo-keeps-lines-and-still-asks-size',
    // A photo can leave a size open or an unmatched item: keep those lines, still ask, do not re-add from scratch.
    turns: [
      { text: 'ordine', attachment: '2 x Pebble hand wash\n1 x Fable fog lantern' },
      { text: 'cliente Northwind Bistro' },
    ],
    scripted: [
      draftSchema.parse({ lines: [
        { query: 'Pebble hand wash', quantity: 2 },
        { query: 'Fable fog lantern', quantity: 1 },
      ] }),
      draftSchema.parse({ clientQuery: 'Northwind Bistro' }),
    ],
    check: all(neverGaveUp, namedFor(northwind.id, /northwind bistro/i), o => {
      const lines = o.open?.draft.lines ?? [];
      const pebble = lines.findIndex(l => /pebble/i.test(l.query) || l.productId === '101' || l.productId === '104');
      const unmatched = lines.findIndex(l => /fog lantern/i.test(l.query));
      return [
        ...expect(pebble >= 0, `the photo hand wash was lost: ${JSON.stringify(lines)}`),
        ...expect(unmatched >= 0, `the unmatched photo line was lost: ${JSON.stringify(lines)}`),
        ...expect(!o.open?.issues?.some(i => i.field === 'lines'), 'asked to restate products already on the draft'),
        ...expect(!!o.open?.issues?.some(i => i.field === `lines.${pebble}`), 'stopped asking for the missing size'),
        ...expect(!!o.open?.issues?.some(i => i.field === `lines.${unmatched}`), 'dropped the unmatched item instead of asking about it'),
      ];
    }),
  },
  {
    id: 'cancelled-request-does-not-copy-lines',
    // A previous request's products must not reappear on a later customer-only order (FAB-39 / FAB-49).
    turns: [
      { text: 'ordine', attachment: '2 x Pebble hand wash 250 ml' },
      { text: 'lascia stare, non serve più' },
      { text: 'crea un nuovo ordine per Northwind Bistro' },
    ],
    scripted: [
      draftSchema.parse({ lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }] }),
      'cancel',
      draftSchema.parse({ clientQuery: 'Northwind Bistro' }),
    ],
    check: all(neverGaveUp, namedFor(northwind.id, /northwind bistro/i), o => [
      ...expect(!o.open?.draft.lines.length, `copied lines from the cancelled request: ${JSON.stringify(o.open?.draft.lines)}`),
      ...expect(!!o.open?.issues?.some(i => i.field === 'lines'), 'did not ask for products on the new request'),
    ]),
  },
  {
    id: 'english-request',
    turns: [{ text: 'Prepare an order for Northwind Bistro: 3 Linen candle 200 g, delivery 8 euros' }],
    check: all(neverGaveUp, orderFor(northwind.id), o => expect(last(o).includes('📦 Order preview'), 'no English order preview')),
  },
  {
    id: 'missing-combination-offers-alternatives',
    // Fig hand soap is not sold; fig shower gel and cedar hand soap are. Say so, and do not lock a different scent.
    turns: [{ text: 'Prepare an order for Example Studio: 2 fig hand soap, delivery 8 euros' }],
    scripted: [draftSchema.parse({
      clientQuery: 'Example Studio',
      lines: [{ query: 'fig hand soap', quantity: 2 }],
      shippingPrice: 8,
    })],
    check: all(neverGaveUp, o => {
      const line = o.open?.draft.lines[0];
      const issue = o.open?.issues?.find(i => i.field === 'lines.0');
      const labels = issue?.candidates?.map(c => c.label).join(' ') ?? '';
      return [
        ...expect(o.open?.draft.clientId === '201' || /example studio/i.test(o.open?.draft.clientQuery ?? ''), `client is ${o.open?.draft.clientId ?? `"${o.open?.draft.clientQuery ?? 'none'}"`}, expected Example Studio`),
        ...expect(!o.open?.draft.newClient, `proposes creating new customer "${o.open?.draft.newClient?.name}"`),
        ...expect(o.open?.status !== 'ready', 'treated a missing combination as a ready order'),
        ...expect(line?.productId !== '106', 'presented cedar hand soap as the requested fig hand soap'),
        ...expect(line?.productId !== '105', 'presented fig shower gel as the requested fig hand soap'),
        ...expect(/fig hand soap/i.test(line?.query ?? ''), 'lost the requested wording'),
        ...expect(/not in the catalogue/i.test(issue?.message ?? ''), `did not say the combination is missing: ${issue?.message}`),
        ...expect(/fig shower gel/i.test(labels), `did not offer the fig products that exist: ${labels}`),
        ...expect(/cedar hand soap/i.test(labels), `did not offer the hand soaps that exist: ${labels}`),
      ];
    }),
  },
  {
    id: 'weak-customer-stays-unmatched',
    turns: [
      { text: 'ordine per Maple' },
      { text: '2 Pebble hand wash 250 ml, spedizione 8 euro, nota: express' },
    ],
    // A unique close account is a question. Filling products, shipping and a note must not lock it.
    scripted: [
      draftSchema.parse({ clientQuery: 'Maple', clientId: maplePine.id }),
      draftSchema.parse({ clientQuery: maplePine.name, clientId: maplePine.id, lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }], shippingPrice: 8, notes: 'express' }),
    ],
    check: all(neverGaveUp, o => [
      ...expect(!o.open?.draft.clientId && o.open?.status === 'suspended', `customer locked as ${o.open?.draft.clientId ?? o.open?.status}`),
      ...expect(!!o.open?.issues?.some(i => i.field === 'client' && i.candidates?.some(c => c.id === maplePine.id)), 'did not offer the close account as a question'),
      ...expect(/🏪 Maple(?: & Pine Trading Ltd)? ❓/.test(last(o)), 'presented the customer as already selected'),
      ...expect(!!o.open?.draft.lines.some(l => l.query === 'Pebble hand wash 250 ml' && l.quantity === 2), 'the product follow-up was lost'),
      ...expect(o.open?.draft.shippingPrice === 8 && o.open?.draft.notes === 'express', 'shipping or note was lost'),
    ]),
  },
  {
    id: 'exact-customer-name-locks',
    turns: [{ text: 'ordine per Maple & Pine Trading Ltd: 2 Pebble hand wash 250 ml, spedizione 8 euro' }],
    scripted: [draftSchema.parse({ clientQuery: maplePine.name, lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }], shippingPrice: 8 })],
    check: all(neverGaveUp, orderFor(maplePine.id)),
  },
  {
    id: 'short-name-on-ready-draft-is-new-search',
    // Ready draft for one fictional account; a short name must search again, not ask to save as-is.
    turns: [
      { text: 'ordine per Example Studio: 2 Pebble hand wash 250 ml, spedizione 8 euro' },
      { text: 'Northwind' },
    ],
    scripted: [readyExampleDraft(), northwindCorrectionDraft()],
    check: readyCustomerCorrection,
  },
  {
    id: 'change-customer-on-ready-draft',
    turns: [
      { text: 'ordine per Example Studio: 2 Pebble hand wash 250 ml, spedizione 8 euro' },
      { text: 'change the customer to Northwind Bistro' },
    ],
    scripted: [readyExampleDraft(), northwindCorrectionDraft()],
    check: readyCustomerCorrection,
  },
  {
    id: 'requested-note-only-from-attachment',
    // The operator asked only for a short Italian instruction; products already belong on the lines (FAB-56).
    turns: [{
      text: 'ordine per Example Studio, spedizione 8 euro, nota: Spedire a gennaio',
      attachment: '2 x Pebble hand wash 250 ml\n2 x Linen candle 200 g',
    }],
    scripted: [draftSchema.parse({
      clientQuery: 'Example Studio',
      lines: [
        { query: 'Pebble hand wash 250 ml', quantity: 2 },
        { query: 'Linen candle 200 g', quantity: 2 },
      ],
      shippingPrice: 8,
      notes: 'Spedire a gennaio',
    })],
    check: all(neverGaveUp, namedFor('201', /example studio/i), onlyRequestedNote('Spedire a gennaio'), o => [
      ...expect(!!o.open?.draft.lines.some(l => l.productId === '101' || /pebble/i.test(l.query)), 'the attached hand wash was lost'),
      ...expect(!!o.open?.draft.lines.some(l => l.productId === '103' || /linen candle/i.test(l.query)), 'the attached candle was lost'),
    ]),
  },
  {
    id: 'requested-english-note-only',
    turns: [{ text: 'Prepare an order for Example Studio: 2 Pebble hand wash 250 ml, delivery 8 euros, note: ship in January' }],
    scripted: [draftSchema.parse({
      clientQuery: 'Example Studio',
      lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }],
      shippingPrice: 8,
      notes: 'ship in January',
    })],
    check: all(neverGaveUp, namedFor('201', /example studio/i), onlyRequestedNote('ship in January')),
  },
  {
    id: 'no-note-when-not-asked',
    turns: [{
      text: 'ordine per Example Studio: 2 Pebble hand wash 250 ml, spedizione 8 euro',
      attachment: '2 x Pebble hand wash 250 ml\n2 x Linen candle 200 g',
    }],
    scripted: [draftSchema.parse({
      clientQuery: 'Example Studio',
      lines: [
        { query: 'Pebble hand wash 250 ml', quantity: 2 },
        { query: 'Linen candle 200 g', quantity: 2 },
      ],
      shippingPrice: 8,
    })],
    check: all(neverGaveUp, namedFor('201', /example studio/i), notesStayEmpty),
  },
];
