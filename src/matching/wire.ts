import { loadMatchingConfig, type MatchingConfig } from './config.js';
import { createJevBatchSelector, sdkTransport } from './jev-client.js';
import type { SelectMany } from './resolver.js';

/**
 * Matcher installed for the current mode. `off` installs none, so core matching
 * runs with no vendor client. Studio, the channel runner and evals call this.
 */
export function wireMatching(env: NodeJS.ProcessEnv = process.env): { config: MatchingConfig; selectMany?: SelectMany } {
  const config = loadMatchingConfig(env);
  if (config.mode === 'off') return { config };
  return { config, selectMany: createJevBatchSelector(config, sdkTransport(config, env.TYPESAFE_API_KEY ?? '')) };
}
