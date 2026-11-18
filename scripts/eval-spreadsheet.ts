import { loadConfig } from '../src/config/load.js';
import { DemoConnector } from '../src/connector/demo.js';
import { expect, runConversation, type ConversationOutcome } from '../src/evals/harness.js';
import {
  fictionalOrderSpreadsheetText,
  fictionalSpreadsheetCatalogue,
  fictionalSpreadsheetCustomer,
} from '../src/evals/spreadsheet-fixture.js';

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
console.log(`Spreadsheet live eval using ${config.model}. Generated fictional workbook only; nothing is saved or sent.`);
console.log('Extracted reading:\n' + reading);

const customerName = fictionalSpreadsheetCustomer.name;
const connector = spreadsheetConnector();
const outcome = await runConversation(config, connector, [
  { text: 'Create order', attachment: reading },
  { text: `Cliente ${customerName}` },
], { log: line => console.log(line) });

function linesHeld(draft: NonNullable<ConversationOutcome['open']>['draft'] | undefined) {
  if (!draft) return ['no draft'];
  return [
    ...expect(!!draft.lines.some(l => /CREAM100ML|grove hand cream/i.test(l.query) && l.quantity === 2), `cream line lost: ${JSON.stringify(draft.lines)}`),
    ...expect(!!draft.lines.some(l => /SPRAY250ML|harbor room spray/i.test(l.query) && l.quantity === 1), 'spray line lost'),
    ...expect(!!draft.lines.some(l => /CANDLE200G|linen candle/i.test(l.query)), 'candle line lost'),
    ...expect(!!draft.lines.some(l => /SOAP250ML|pebble hand wash/i.test(l.query)), 'soap line lost'),
    ...expect(!!draft.lines.some(l => /MIST100ML|cedar mist/i.test(l.query)), 'mist line lost'),
    ...expect(!!draft.lines.some(l => /OIL30ML|birch oil/i.test(l.query)), 'oil line lost'),
    ...expect(!!draft.lines.some(l => /BALM50ML|moss balm/i.test(l.query)), 'balm line lost'),
    ...expect(!!draft.lines.some(l => /SAMPLE-T|tester pebble/i.test(l.query) && /tester/i.test(l.query)), 'tester row lost'),
  ];
}

const draft = outcome.open?.draft;
const reply = outcome.replies.join('\n');
const named = new RegExp(customerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const customerHeld = outcome.open?.draft.clientId === fictionalSpreadsheetCustomer.id
  || named.test(outcome.open?.draft.clientQuery ?? '')
  || !!outcome.open?.issues?.some(i => i.field === 'client' && i.candidates?.some(c => named.test(c.label)));
const clientOpen = !!outcome.open?.issues?.some(i => i.field === 'client');
const problems = [
  ...expect(!!draft, 'no open request after Create order + customer name'),
  ...expect(!/northwind supplies/i.test(draft?.clientQuery ?? ''), `used supplier letterhead as customer: ${draft?.clientQuery}`),
  ...expect(!/northwind supplies/i.test(draft?.newClient?.name ?? ''), `proposed creating the supplier: ${draft?.newClient?.name}`),
  ...expect(!draft?.newClient, `offered to create "${draft?.newClient?.name}" instead of the existing customer`),
  ...expect(customerHeld, `customer lookup missed ${customerName}: query=${draft?.clientQuery ?? ''} id=${draft?.clientId ?? 'none'}`),
  ...linesHeld(draft),
  ...expect(!draft?.lines.some(l => l.documentPrice), 'set a file price without a pending document price'),
  ...expect(!/\b(file|document|spreadsheet).{0,40}(price|catalogue)|catalogue.{0,40}(file|document)/i.test(reply), `asked file versus catalogue: ${reply.split('\n')[0]}`),
  ...expect(draft?.shippingPrice === undefined, `invented a delivery charge of ${draft?.shippingPrice}`),
  ...expect(
    clientOpen || !!outcome.open?.issues?.some(i => i.field === 'shippingPrice'),
    'neither asked to confirm the customer nor kept the last-charge shipping question',
  ),
  ...expect(!clientOpen || !!outcome.open?.issues?.some(i => i.field === 'client' && (i.candidates?.length ?? 0) > 0) || named.test(draft?.clientQuery ?? ''), 'asked for a customer without a candidate from search'),
  ...expect(!draft?.notes?.trim(), `wrote a note nobody asked for: ${JSON.stringify(draft?.notes)}`),
  ...expect(outcome.open?.status !== 'saved' && outcome.open?.status !== 'saving', `saved without confirm (${outcome.open?.status ?? 'none'})`),
];

if (problems.length) {
  console.log(`FAIL spreadsheet-create-order\n${problems.map(p => `- ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('PASS spreadsheet-create-order');
console.log(`Open draft: customer ${draft?.clientId ?? draft?.clientQuery ?? 'unmatched'}; ${draft?.lines.length ?? 0} lines; status ${outcome.open?.status}; issues ${(outcome.open?.issues ?? []).map(i => i.field).join(', ') || 'none'}.`);
