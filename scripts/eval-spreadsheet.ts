import { loadConfig } from '../src/config/load.js';
import { orderPreview } from '../src/channel/preview.js';
import { DemoConnector } from '../src/connector/demo.js';
import { toFicOrder } from '../src/connector/fatture-in-cloud.js';
import { expect, runConversation, type ConversationOutcome } from '../src/evals/harness.js';
import {
  fictionalOrderSpreadsheetText,
  fictionalSpreadsheetCatalogue,
  fictionalSpreadsheetCustomer,
} from '../src/evals/spreadsheet-fixture.js';

const testerProduct = fictionalSpreadsheetCatalogue.find(p => p.id === '808')!;
const saleSoap = fictionalSpreadsheetCatalogue.find(p => p.id === '804')!;

function spreadsheetConnector() {
  const connector = new DemoConnector();
  connector.products.push(...structuredClone(fictionalSpreadsheetCatalogue));
  connector.clients.push(structuredClone(fictionalSpreadsheetCustomer));
  return connector;
}

const missing: string[] = [];
if (!process.env.OPENAI_API_KEY?.trim()) missing.push('OPENAI_API_KEY');
if ((process.env.MATCHER_MODE === 'on' || process.env.JEV_MODE === 'on') && !process.env.TYPESAFE_API_KEY?.trim()) {
  missing.push('TYPESAFE_API_KEY');
}

if (missing.length) {
  console.log(`spreadsheet live eval blocked: missing ${missing.join(', ')}. No live account writes were attempted.`);
  process.exit(2);
}

process.env.EVALS_ENABLED = 'false';
const config = await loadConfig('config/example.json');
config.model = process.env.EVAL_AGENT_MODEL ?? config.model;
const reading = await fictionalOrderSpreadsheetText();
const matcher = process.env.MATCHER_MODE?.trim() || process.env.JEV_MODE?.trim() || 'off';
console.log(`Spreadsheet live eval using ${config.model}, MATCHER_MODE=${matcher}. Generated fictional workbook only; nothing is saved or sent.`);
console.log('Extracted reading:\n' + reading);

const customerName = fictionalSpreadsheetCustomer.name;
const connector = spreadsheetConnector();
const snapshots: ConversationOutcome[] = [];
const outcome = await runConversation(config, connector, [
  { text: 'Create order', attachment: reading },
  { text: `Cliente ${customerName}` },
  { text: 'delivery 8' },
], {
  log: line => console.log(line),
  onTurn: (_index, snap) => snapshots.push(snap),
  extraTurns: (_index, snap) => {
    if (_index !== 1) return;
    if (snap.open?.draft.clientId === fictionalSpreadsheetCustomer.id) return;
    const named = new RegExp(customerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (snap.open?.issues?.some(i => i.field === 'client' && i.candidates?.some(c => named.test(c.label)))) {
      return [{ press: customerName }];
    }
  },
});

function linesHeld(draft: NonNullable<ConversationOutcome['open']>['draft'] | undefined) {
  if (!draft) return ['no draft'];
  const tester = draft.lines.filter(l => l.tester || /tester/i.test(l.query));
  const soapSale = draft.lines.filter(l => /SOAP250ML|pebble hand wash/i.test(l.query) && !l.tester && l.quantity === 2);
  return [
    ...expect(draft.lines.length === 8, `expected 8 lines, got ${draft.lines.length}`),
    ...expect(!!draft.lines.some(l => /CREAM100ML|grove hand cream/i.test(l.query) && l.quantity === 2), `cream line lost: ${JSON.stringify(draft.lines)}`),
    ...expect(!!draft.lines.some(l => /SPRAY250ML|harbor room spray/i.test(l.query) && l.quantity === 1), 'spray line lost'),
    ...expect(!!draft.lines.some(l => /CANDLE200G|linen candle/i.test(l.query)), 'candle line lost'),
    ...expect(soapSale.length === 1, `sale soap qty 2 lost: ${JSON.stringify(draft.lines)}`),
    ...expect(!!draft.lines.some(l => /MIST100ML|cedar mist/i.test(l.query)), 'mist line lost'),
    ...expect(!!draft.lines.some(l => /OIL30ML|birch oil/i.test(l.query)), 'oil line lost'),
    ...expect(!!draft.lines.some(l => /BALM50ML|moss balm/i.test(l.query)), 'balm line lost'),
    ...expect(tester.length === 1 && tester[0]?.quantity === 1, `tester line lost or merged: ${JSON.stringify(tester)}`),
    ...expect(!!tester[0]?.tester || /tester/i.test(tester[0]?.query ?? ''), 'tester intent missing on the tester line'),
    ...expect(/SOAP250ML|pebble hand wash/i.test(tester[0]?.query ?? ''), 'tester line dropped the printed sale identity'),
    ...expect(tester[0]?.productId !== saleSoap.id, 'tester line quietly selected the sale SKU'),
  ];
}

function customerState(open: ConversationOutcome['open']) {
  const named = new RegExp(customerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const clientIssue = open?.issues?.find(i => i.field === 'client');
  const locked = open?.draft.clientId === fictionalSpreadsheetCustomer.id;
  const asked = !!clientIssue && (clientIssue.candidates?.some(c => named.test(c.label)) || named.test(open?.draft.clientQuery ?? ''));
  return {
    named,
    locked,
    asked,
    held: locked || asked || named.test(open?.draft.clientQuery ?? ''),
    clientOpen: !!clientIssue,
  };
}

const afterCreate = snapshots[0];
const afterCustomer = snapshots[1];
const afterShipping = snapshots.at(-1) ?? outcome;
const reply = outcome.replies.join('\n');
const create = customerState(afterCreate?.open);
const namedCustomer = customerState(afterCustomer?.open);
const shipped = customerState(afterShipping.open);
const draft = afterShipping.open?.draft;

const problems = [
  ...expect(!!afterCreate?.open, 'no open request after Create order'),
  ...expect(!afterCreate?.open?.draft.clientId, 'locked a customer before one was named'),
  ...expect(!/northwind supplies/i.test(afterCreate?.open?.draft.clientQuery ?? ''), `used supplier letterhead as customer: ${afterCreate?.open?.draft.clientQuery}`),
  ...expect(!afterCreate?.open?.draft.newClient, `proposed creating "${afterCreate?.open?.draft.newClient?.name}" on create-order`),
  ...expect(create.clientOpen, 'did not ask for the missing customer on create-order'),
  ...linesHeld(afterCreate?.open?.draft),
  ...expect(!!afterCustomer?.open, 'lost the request after the customer name'),
  ...expect(!/northwind supplies/i.test(afterCustomer?.open?.draft.clientQuery ?? ''), `used supplier letterhead as customer: ${afterCustomer?.open?.draft.clientQuery}`),
  ...expect(!afterCustomer?.open?.draft.newClient, `offered to create "${afterCustomer?.open?.draft.newClient?.name}" instead of the existing customer`),
  ...expect(namedCustomer.held, `customer lookup missed ${customerName}: query=${afterCustomer?.open?.draft.clientQuery ?? ''} id=${afterCustomer?.open?.draft.clientId ?? 'none'}`),
  ...expect(
    namedCustomer.locked || namedCustomer.asked,
    namedCustomer.locked
      ? 'locked customer'
      : 'named customer was neither locked as an exact match nor shown as a confirmation candidate',
  ),
  ...linesHeld(afterCustomer?.open?.draft),
  ...expect(afterCustomer?.open?.draft.shippingPrice === undefined, `invented a delivery charge of ${afterCustomer?.open?.draft.shippingPrice} before shipping was given`),
  ...expect(!!afterShipping.open, 'lost the request after shipping'),
  ...expect(shipped.held, 'customer was dropped after shipping'),
  ...linesHeld(afterShipping.open?.draft),
  ...expect(draft?.shippingPrice === 8, `shipping was not kept after the operator set it: ${draft?.shippingPrice}`),
  ...expect(!draft?.lines.some(l => l.documentPrice), 'set a file price without a pending document price'),
  ...expect(!/\b(file|document|spreadsheet).{0,40}(price|catalogue)|catalogue.{0,40}(file|document)/i.test(reply), `asked file versus catalogue: ${reply.split('\n')[0]}`),
  ...expect(!draft?.notes?.trim(), `wrote a note nobody asked for: ${JSON.stringify(draft?.notes)}`),
  ...expect(afterShipping.open?.status !== 'saved' && afterShipping.open?.status !== 'saving', `saved without confirm (${afterShipping.open?.status ?? 'none'})`),
  ...expect(connector.createCalls === 0, `connector wrote ${connector.createCalls} orders before the isolated fake save`),
];

const prepared = afterShipping.open?.prepared;
if (prepared) {
  const testerLine = prepared.lines.find(l => l.productId === testerProduct.id);
  const preview = orderPreview(prepared, afterShipping.open?.totals ?? { net: 0, vat: 0, gross: 0 }, true);
  problems.push(
    ...expect(afterShipping.open?.status === 'ready', `expected ready preview, got ${afterShipping.open?.status}`),
    ...expect(!!testerLine, `prepared order missing tester product ${testerProduct.id}: ${JSON.stringify(prepared.lines.map(l => ({ id: l.productId, code: l.code, name: l.name })))}`),
    ...expect(testerLine?.code === testerProduct.code, `tester code ${testerLine?.code}`),
    ...expect(testerLine?.name === testerProduct.name, `tester name ${testerLine?.name}`),
    ...expect(testerLine?.description === testerProduct.description, 'tester description lost'),
    ...expect(testerLine?.netPrice === testerProduct.netPrice, `tester used ${testerLine?.netPrice} instead of its catalogue price`),
    ...expect(testerLine?.quantity === 1, `tester quantity ${testerLine?.quantity}`),
    ...expect(!prepared.lines.some(l => !l.shipping && l.productId === testerProduct.id && l.productId === saleSoap.id), 'tester and sale share an id'),
    ...expect(prepared.lines.some(l => l.productId === saleSoap.id && l.quantity === 2 && l.netPrice === saleSoap.netPrice), 'sale soap line lost from prepared order'),
    ...expect(/tester/i.test(preview), `ready preview has no tester designation: ${preview}`),
    ...expect(!prepared.lines.some(l => l.productId === saleSoap.id && l.quantity === 1 && /tester/i.test(l.name)), 'sale SKU billed as qty 1 tester'),
  );
  const payload = toFicOrder(prepared);
  const testerItem = payload.items_list?.find(item => item.product_id === Number(testerProduct.id));
  const saleItem = payload.items_list?.find(item => item.product_id === Number(saleSoap.id));
  problems.push(
    ...expect(!!testerItem, `invoicing payload missing tester id ${testerProduct.id}`),
    ...expect(testerItem?.code === testerProduct.code, `payload tester code ${testerItem?.code}`),
    ...expect(testerItem?.name === testerProduct.name, `payload tester name ${testerItem?.name}`),
    ...expect(testerItem?.description === testerProduct.description, 'payload tester description lost'),
    ...expect(testerItem?.net_price === testerProduct.netPrice, `payload tester price ${testerItem?.net_price}`),
    ...expect(saleItem?.product_id === Number(saleSoap.id) && saleItem?.qty === 2, 'payload sale soap line lost'),
    ...expect(saleItem?.product_id !== testerItem?.product_id, 'payload used the sale id for the tester'),
  );
  const fake = await connector.createOrder(prepared);
  const stored = connector.orders.get(fake.id);
  problems.push(
    ...expect(!!stored?.lines.some(l => l.productId === testerProduct.id && l.code === testerProduct.code && l.name === testerProduct.name), 'isolated fake save lost the tester catalogue identity'),
    ...expect(!stored?.lines.some(l => l.productId === saleSoap.id && l.quantity === 1 && l.netPrice === saleSoap.netPrice && /tester/i.test(l.name)), 'isolated fake save billed the sale SKU as the tester'),
  );
} else {
  problems.push('shipping turn did not produce a prepared order to validate tester identity');
}

if (problems.length) {
  console.log(`FAIL spreadsheet-create-order\n${problems.map(p => `- ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('PASS spreadsheet-create-order');
console.log(`Turn 1 create-order: ${afterCreate?.open?.draft.lines.length ?? 0} lines, customer ${afterCreate?.open?.draft.clientId ?? 'unmatched'}, issues ${(afterCreate?.open?.issues ?? []).map(i => i.field).join(', ') || 'none'}.`);
console.log(`Turn 2 customer: ${namedCustomer.locked ? 'exact lock' : namedCustomer.asked ? 'confirmation candidate' : 'unmatched'}; ${afterCustomer?.open?.draft.lines.length ?? 0} lines.`);
console.log(`Turn 3 shipping: customer ${draft?.clientId ?? draft?.clientQuery ?? 'unmatched'}; ${draft?.lines.length ?? 0} lines; shipping ${draft?.shippingPrice}; status ${afterShipping.open?.status}.`);
