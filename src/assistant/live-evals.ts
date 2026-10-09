import type { MastraScorer, MastraScorers } from '@mastra/core/evals';
import { RequestContext } from '@mastra/core/request-context';

export type LiveEvalSettings = { enabled: boolean; rate: number };
export function liveEvalSettings(env: NodeJS.ProcessEnv = process.env): LiveEvalSettings {
  const enabled = env.EVALS_ENABLED ?? 'true';
  const rate = Number(env.EVALS_SAMPLE_RATE ?? '0.1');
  if (!['true', 'false'].includes(enabled)) throw new Error('EVALS_ENABLED must be true or false');
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error('EVALS_SAMPLE_RATE must be between 0 and 1');
  return { enabled: enabled === 'true', rate };
}
/** Marks Telegram runs, whose wording is scored on the delivered reply instead of the agent run. */
export function evalContext() {
  const context = new RequestContext();
  context.set('evalChannel', 'telegram');
  return context;
}
export function liveAgentScorers(scorers: Record<string, MastraScorer>, settings: LiveEvalSettings): MastraScorers {
  if (!settings.enabled) return {};
  return Object.fromEntries(Object.entries(scorers).map(([key, scorer]) => [key, {
    scorer, sampling: { type: 'ratio' as const, rate: settings.rate },
    // Telegram text quality is scored on the delivered reply instead, which includes the application's templates.
    ...(key === 'toolCallAccuracy' || key === 'workflowAdherence' ? {} : { filter: { op: 'notIn' as const, value: { path: 'requestContext.evalChannel' }, set: ['telegram'] } }),
  }]));
}
