import { createScorer, type ScorerRunInputForAgent, type ScorerRunOutputForAgent, type Trajectory } from '@mastra/core/evals';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { createManualScorers } from '../assistant/manual-scorers.js';
import { delegated } from '../assistant/eval-evidence.js';
import type { LiveEvalSettings } from '../assistant/live-evals.js';

export const deliveredEvidenceSchema = z.object({
  input: z.custom<ScorerRunInputForAgent>(),
  output: z.custom<ScorerRunOutputForAgent>(),
  trajectory: z.custom<Trajectory>(),
});

/** No model generation, no sends, no writes: native step scorers observe a delivered reply. */
export function createDeliveredReplyWorkflow(scorers: ReturnType<typeof createManualScorers>, settings: LiveEvalSettings) {
  const keys = ['conciseness', 'languageConsistency', 'contextRetention', 'userReportedMistakes', 'workflowAdherence'] as const;
  const attachments = Object.fromEntries(keys.map(key => {
    const delegate = scorers[key];
    // Mastra merges workflow listings by name and registered scorers by ID.
    // Keep these identical to avoid duplicate Studio rows; retain stored score IDs.
    const scorer = createScorer({
      id: `telegram-${delegate.id}`, name: `telegram-${delegate.id}`,
      description: `LLM judge — ${delegate.name}. Evaluates delivered Telegram replies with conversation and application evidence.`,
      type: { input: deliveredEvidenceSchema, output: deliveredEvidenceSchema }, judge: delegate.judge,
    }).analyze(async ({ run }) => {
      const evidence = run.output;
      const result = key === 'workflowAdherence'
        ? await scorers.workflowAdherence.run({ input: evidence.input, output: evidence.trajectory })
        : await scorers[key].run({ input: evidence.input, output: evidence.output });
      return delegated(result);
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
