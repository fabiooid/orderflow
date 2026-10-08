import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import type { OrderConnector } from '../connector/contract.js';
import { prepareOrder, type ValidationLookup } from '../domain/prepare.js';
import { draftSchema, preparedOrderSchema, totalsSchema, type OrderDraft } from '../domain/types.js';

export type Extractor = (text: string, orderId: string) => Promise<OrderDraft>;
export const workflowInput = z.object({
  orderId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  text: z.string().min(1).max(12000),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const extractedSchema = z.object({ orderId: z.string(), draft: draftSchema, date: z.string(), policyVersion: z.string() });
const resultSchema = z.object({ orderId: z.string(), order: preparedOrderSchema, totals: totalsSchema });
const issueSchema = z.object({ field: z.string(), message: z.string(), candidates: z.array(z.object({ id: z.number(), label: z.string() })).optional(), priceComparison: z.object({ document: z.number(), catalogue: z.number(), basis: z.enum(['net', 'gross', 'unclear']) }).optional() });

/** Preparation has no writes. Persisting an order is a separate application operation. */
export function createOrderWorkflow(config: AppConfig, connector: OrderConnector, extract: Extractor, validateVat?: ValidationLookup) {
  const extractStep = createStep({
    id: 'extract-order', inputSchema: workflowInput, outputSchema: extractedSchema,
    execute: async ({ inputData }) => ({
      orderId: inputData.orderId, date: inputData.date, policyVersion: config.policyVersion,
      draft: draftSchema.parse(await extract(inputData.text, inputData.orderId)),
    }),
  });
  const prepareStep = createStep({
    id: 'prepare-order', inputSchema: extractedSchema, outputSchema: resultSchema,
    resumeSchema: z.object({ draft: draftSchema }),
    suspendSchema: z.object({ draft: draftSchema, issues: z.array(issueSchema) }),
    execute: async ({ inputData, resumeData, suspend }) => {
      if (inputData.policyVersion !== config.policyVersion) throw new Error('Policy changed while order was paused; restart preparation');
      const draft = resumeData?.draft ?? inputData.draft;
      const result = await prepareOrder(draft, config, connector, inputData.date, validateVat);
      if (!result.ready) return suspend({ draft: result.draft, issues: result.issues });
      const totals = await connector.calculateTotals(result.order);
      return { orderId: inputData.orderId, order: result.order, totals };
    },
  });
  return createWorkflow({ id: 'prepare-order', inputSchema: workflowInput, outputSchema: resultSchema })
    .then(extractStep).then(prepareStep).commit();
}
