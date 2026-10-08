import { createStep, createWorkflow } from '@mastra/core/workflows';
import { createIdentityResolver, changedIdentities, confirmedChoiceSchema, decisionSchema, resolutionContextSchema, type IdentityResolver } from '../matching/resolver.js';
import { traceOperation } from './execution-trace.js';
import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import type { OrderConnector } from '../connector/contract.js';
import { prepareOrder, type ValidationLookup } from '../domain/prepare.js';
import { draftSchema, preparedOrderSchema, totalsSchema, type OrderDraft, type Product, type Client } from '../domain/types.js';

export type Extractor = (text: string, orderId: string) => Promise<OrderDraft>;
export const workflowInput = z.object({
  orderId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  text: z.string().min(1).max(12000),
  revision: z.number().int().nonnegative().optional(),
  operatorText: z.string().max(12000).optional(),
  latestOperatorText: z.string().max(12000).optional(),
  confirmedChoices: z.array(confirmedChoiceSchema).max(101).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const extractedSchema = z.object({ orderId: z.string(), draft: draftSchema, date: z.string(), policyVersion: z.string(), context: resolutionContextSchema });
const resultSchema = z.object({ orderId: z.string(), order: preparedOrderSchema, totals: totalsSchema, draft: draftSchema, decisions: z.array(decisionSchema) });
const issueSchema = z.object({ matchingStatus: z.enum(['ambiguous', 'no-match', 'unavailable']).optional(), field: z.string(), message: z.string(), candidates: z.array(z.object({ id: z.number(), label: z.string() })).optional(), priceComparison: z.object({ document: z.number(), catalogue: z.number(), basis: z.enum(['net', 'gross', 'unclear']) }).optional() });

/** Preparation has no writes. Persisting an order is a separate application operation. */
export function createOrderWorkflow(config: AppConfig, connector: OrderConnector, extract: Extractor, validateVat?: ValidationLookup, matching: IdentityResolver = createIdentityResolver(config, connector)) {
  const extractStep = createStep({
    id: 'extract-order', inputSchema: workflowInput, outputSchema: extractedSchema,
    execute: async ({ inputData }) => ({
      context: { confirmedChoices: inputData.confirmedChoices, orderId: inputData.orderId, revision: inputData.revision ?? 0, operatorText: inputData.operatorText ?? inputData.text, latestOperatorText: inputData.latestOperatorText ?? inputData.operatorText ?? inputData.text },
      orderId: inputData.orderId, date: inputData.date, policyVersion: config.policyVersion,
      draft: draftSchema.parse(await extract(inputData.text, inputData.orderId)),
    }),
  });
  const resolvedSchema = extractedSchema.extend({ issues: z.array(issueSchema), decisions: z.array(decisionSchema) });
  const resolveStep = createStep({
    id: 'resolve-identities', inputSchema: extractedSchema, outputSchema: resolvedSchema,
    execute: async ({ inputData }) => ({ ...inputData, ...await matching.resolve(inputData.draft, inputData.context) }),
  });
  const prepareStep = createStep({
    id: 'prepare-order', inputSchema: resolvedSchema.extend({ context: resolutionContextSchema.optional(), issues: z.array(issueSchema).default([]), decisions: z.array(decisionSchema).default([]) }), outputSchema: resultSchema,
    resumeSchema: z.object({ draft: draftSchema, confirmedChoices: z.array(confirmedChoiceSchema).max(101).optional(), latestOperatorText: z.string().max(12000).optional(), operatorText: z.string().max(12000).optional(), revision: z.number().int().nonnegative().optional() }),
    suspendSchema: z.object({ draft: draftSchema, issues: z.array(issueSchema), decisions: z.array(decisionSchema), context: resolutionContextSchema }),
    execute: async ({ inputData, resumeData, suspend }) => {
      if (inputData.policyVersion !== config.policyVersion) throw new Error('Policy changed while order was paused; restart preparation');
      // Runs suspended before identity resolution was introduced have no context.
      const savedContext = inputData.context ?? { orderId: inputData.orderId, revision: 0, operatorText: '' };
      const context = { ...savedContext, confirmedChoices: resumeData?.confirmedChoices ?? savedContext.confirmedChoices, operatorText: resumeData?.operatorText ?? savedContext.operatorText,
        revision: resumeData?.revision ?? savedContext.revision, latestOperatorText: resumeData?.latestOperatorText ?? resumeData?.operatorText ?? savedContext.latestOperatorText };
      // Resuming the preparation step must never bypass identity validation.
      const resolution = resumeData ? await traceOperation('Resolve identities on resume', () => matching.resolve(resumeData.draft, context)) : inputData;
      const { draft, decisions } = resolution;
      if (resolution.issues.length) return suspend({ draft, issues: resolution.issues, decisions, context });
      let products: Product[] = [], clients: Client[] = [];
      const result = await prepareOrder(draft, config, {
        listProducts: async () => products = await connector.listProducts(),
        listClients: async () => clients = await connector.listClients(),
      }, inputData.date, validateVat);
      const changed = matching.mode === 'on' ? changedIdentities(decisions, products, clients) : [];
      if (changed.length) return suspend({ draft, issues: changed, decisions, context });
      if (!result.ready) return suspend({ draft: result.draft, issues: result.issues, decisions, context });
      const totals = await connector.calculateTotals(result.order);
      return { orderId: inputData.orderId, order: result.order, totals, draft, decisions };
    },
  });
  return createWorkflow({ id: 'prepare-order', inputSchema: workflowInput, outputSchema: resultSchema })
    .then(extractStep).then(resolveStep).then(prepareStep).commit();
}
