import type { MastraScorer, MastraScorers } from '@mastra/core/evals';
import { RequestContext } from '@mastra/core/request-context';

export type LiveEvalSettings = { enabled: boolean; rate: number };
export function liveEvalSettings(env: NodeJS.ProcessEnv = process.env): LiveEvalSettings {
  const enabled = env.EVALS_ENABLED ?? 'true';
  const rate = Number(env.EVALS_SAMPLE_RATE ?? '1');
  if (!['true', 'false'].includes(enabled)) throw new Error('EVALS_ENABLED must be true or false');
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error('EVALS_SAMPLE_RATE must be between 0 and 1');
  return { enabled: enabled === 'true', rate };
}
export function evalContext(purpose: 'extraction' | 'wording' | 'catalogue' | 'routing' | 'delivered', channel = 'telegram') {
  const context = new RequestContext();
  context.set('evalPurpose', purpose);
  context.set('evalChannel', channel);
  return context;
}
export function liveAgentScorers(scorers: Record<string, MastraScorer>, settings: LiveEvalSettings): MastraScorers {
  if (!settings.enabled) return {};
  return Object.fromEntries(Object.entries(scorers).map(([key, scorer]) => [key, {
    scorer, sampling: { type: 'ratio' as const, rate: settings.rate },
    filter: key === 'toolCallAccuracy' || key === 'workflowAdherence'
      ? { op: 'notIn' as const, value: { path: 'requestContext.evalPurpose' }, set: ['wording'] }
      : { op: 'and' as const, args: [
        { op: 'notIn' as const, value: { path: 'requestContext.evalChannel' }, set: ['telegram'] },
        { op: 'notIn' as const, value: { path: 'requestContext.evalPurpose' }, set: ['extraction', 'wording'] },
      ] },
  }]));
}
