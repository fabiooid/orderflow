import { createScorer, notScorable, type ScorerRunInputForAgent, type ScorerRunOutputForAgent, type Trajectory } from '@mastra/core/evals';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { createManualScorers } from '../assistant/manual-scorers.js';
import type { LiveEvalSettings } from '../assistant/live-evals.js';

export const deliveredEvidenceSchema = z.object({
  input: z.custom<ScorerRunInputForAgent>(),
  output: z.custom<ScorerRunOutputForAgent>(),
  trajectory: z.custom<Trajectory>(),
});
export type DeliveredEvidence = z.infer<typeof deliveredEvidenceSchema>;

/** No model generation, no sends, no writes: native step scorers observe a delivered reply. */
export function createDeliveredReplyWorkflow(scorers: ReturnType<typeof createManualScorers>, settings: LiveEvalSettings) {
  const keys = ['conciseness', 'languageConsistency', 'contextRetention', 'userReportedMistakes', 'workflowAdherence'] as const;
  const attachments = Object.fromEntries(keys.map(key => {
    const delegate = scorers[key];
    const scorer = createScorer({
      id: `telegram-${delegate.id}`, name: `Telegram: ${delegate.name}`,
      description: 'Evaluates the delivered Telegram reply and recorded application state with conversation history.',
      type: { input: deliveredEvidenceSchema, output: deliveredEvidenceSchema }, judge: delegate.judge,
    }).analyze(async ({ run }) => {
      const evidence = run.output;
      const result = key === 'workflowAdherence'
        ? await scorers.workflowAdherence.run({ input: evidence.input, output: evidence.trajectory })
        : await scorers[key].run({ input: evidence.input, output: evidence.output });
      if (result.notScorable) return notScorable(result.notScorable.reason);
      return { score: result.score, reason: result.reason ?? '', details: result.analyzeStepResult };
    }).generateScore(({ results }) => results.analyzeStepResult.score)
      .generateReason(({ results }) => results.analyzeStepResult.reason);
    return [key, { scorer, sampling: { type: 'ratio' as const, rate: settings.rate } }];
  }));
  const step = createStep({
    id: 'delivered-reply', inputSchema: deliveredEvidenceSchema, outputSchema: deliveredEvidenceSchema,
    scorers: settings.enabled ? attachments : {},
    execute: async ({ inputData }) => inputData,
  });
  return createWorkflow({ id: 'telegram-delivered-reply', inputSchema: deliveredEvidenceSchema, outputSchema: deliveredEvidenceSchema })
    .then(step).commit();
}
