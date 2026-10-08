import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { createScorer } from '@mastra/core/evals';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { AppConfig } from '../config/schema.js';
import type { OrderConnector } from '../connector/contract.js';
import { draftSchema, type OrderDraft } from '../domain/types.js';
import { prepareOrder } from '../domain/prepare.js';
import type { Extractor } from './workflow.js';

const line = z.object({ productId: z.number(), quantity: z.number(), netPrice: z.number(), discountPercent: z.number(), vatId: z.number() });
export const acceptanceOutcome = z.discriminatedUnion('ready', [
  z.object({ ready: z.literal(false), issues: z.array(z.string()) }),
  z.object({ ready: z.literal(true), clientId: z.number().optional(), lines: z.array(line), deliveryCountry: z.string(), totals: z.object({ net: z.number(), vat: z.number(), gross: z.number() }) }),
]);
type Outcome = z.infer<typeof acceptanceOutcome>;
const merchandise = (quantity = 2, netPrice = 12, discountPercent = 0) => ({ productId: 101, quantity, netPrice, discountPercent, vatId: 1 });
const shipping = { productId: 900, quantity: 1, netPrice: 8, discountPercent: 0, vatId: 1 };
const base = draftSchema.parse({ clientQuery: 'Example Studio', lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }], shippingPrice: 8 });
const ready = (lines: z.infer<typeof line>[], net: number, vat: number, gross: number): Outcome => ({ ready: true, clientId: 201, lines, deliveryCountry: 'IT', totals: { net, vat, gross } });

/** Fictional examples only. Expected outcomes are never supplied to the model. */
export const acceptanceCases: { id: string; messages: string[]; scripted: OrderDraft[]; expected: Outcome }[] = [
  { id: 'italian-order', messages: ['Prepara un ordine per Example Studio: 2 Pebble hand wash 250 ml. Spedizione 8 euro.'], scripted: [base], expected: ready([merchandise(), shipping], 32, 7.04, 39.04) },
  { id: 'english-order', messages: ['Prepare an order for Example Studio: two Pebble hand wash 250 ml, delivery 8 euros.'], scripted: [base], expected: ready([merchandise(), shipping], 32, 7.04, 39.04) },
  { id: 'quantity-correction', messages: ['Prepara un ordine per Example Studio: 2 Pebble hand wash 250 ml, spedizione 8 euro.', 'No, ho detto 5 pezzi, non 2. Il resto è corretto.'], scripted: [base, { ...base, lines: [{ query: 'Pebble hand wash 250 ml', quantity: 5 }] }], expected: ready([merchandise(5), shipping], 68, 14.96, 82.96) },
  { id: 'custom-price', messages: ['Order for Example Studio: 2 Pebble hand wash 250 ml at a custom net unit price of 9 euros, 10% discount on products only, delivery 8 euros.'], scripted: [{ ...base, lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2, netPrice: 9 }], discountPercent: 10 }], expected: ready([merchandise(2, 9, 10), shipping], 24.2, 5.32, 29.52) },
  { id: 'discount-excludes-delivery', messages: ['Ordine per Example Studio: 2 Pebble hand wash 250 ml, sconto 10%, spedizione 8 euro.'], scripted: [{ ...base, discountPercent: 10 }], expected: ready([merchandise(2, 12, 10), shipping], 29.6, 6.51, 36.11) },
  { id: 'missing-delivery', messages: ['Prepare an order for Example Studio: 2 Pebble hand wash 250 ml.'], scripted: [{ ...base, shippingPrice: undefined }], expected: { ready: false, issues: ['shippingPrice'] } },
];

export const acceptanceScorer = createScorer<unknown, Outcome>({ id: 'acceptance-exact-order', name: 'Acceptance: exact order', description: 'Expected customer, lines, prices, discounts, VAT, delivery, totals or clarification fields' })
  .generateScore(({ run }) => acceptanceOutcome.safeParse(run.groundTruth).success && acceptanceOutcome.safeParse(run.output).success && isDeepStrictEqual(run.output, run.groundTruth) ? 1 : 0)
  .generateReason(({ run }) => isDeepStrictEqual(run.output, run.groundTruth) ? 'All expected fields match.' : `Expected ${JSON.stringify(run.groundTruth)}; observed ${JSON.stringify(run.output)}.`);

/** Exercises actual extraction and preparation, without any save or messaging capability. */
export function createAcceptanceWorkflow(config: AppConfig, connector: OrderConnector, extract: Extractor, observeDraft?: (scenarioId: string, draft: OrderDraft) => void) {
  const inputSchema = z.object({ scenarioId: z.string() });
  const step = createStep({
    id: 'acceptance-conversation', inputSchema, outputSchema: acceptanceOutcome,
    execute: async ({ inputData }) => {
      const scenario = acceptanceCases.find(c => c.id === inputData.scenarioId);
      if (!scenario) throw new Error('Unknown acceptance scenario');
      let currentDraft = draftSchema.parse({});
      let pendingQuestions: unknown = [];
      let outcome: Outcome = { ready: false, issues: [] };
      for (const operatorMessage of scenario.messages) {
        currentDraft = await extract(JSON.stringify({ currentDraft, pendingQuestions, operatorMessage, task: 'Prepare order' }), `acceptance-${scenario.id}`);
        observeDraft?.(scenario.id, currentDraft);
        const prepared = await prepareOrder(currentDraft, config, connector, '2026-01-15');
        if (!prepared.ready) { pendingQuestions = prepared.issues; outcome = { ready: false, issues: prepared.issues.map(i => i.field).sort() }; }
        else {
          pendingQuestions = [];
          outcome = { ready: true, clientId: prepared.order.client.id, lines: prepared.order.lines.map(({ productId, quantity, netPrice, discountPercent, vatId }) => ({ productId, quantity, netPrice, discountPercent, vatId })), deliveryCountry: prepared.order.delivery.country, totals: await connector.calculateTotals(prepared.order) };
        }
      }
      return outcome;
    },
  });
  return createWorkflow({ id: 'acceptance-conversations', inputSchema, outputSchema: acceptanceOutcome }).then(step).commit();
}
