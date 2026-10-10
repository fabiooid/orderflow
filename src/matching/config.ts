import { z } from 'zod';

export const matchingConfigSchema = z.object({
  largeClientSearch: z.boolean().default(false),
  mode: z.enum(['off', 'shadow', 'on']).default('off'),
  model: z.string().trim().min(1).default('jev-1.13.0'),
  timeoutMs: z.coerce.number().int().min(100).max(60000).default(15000),
  maxRetries: z.coerce.number().int().min(0).max(2).default(1),
}).strict();
export type MatchingConfig = z.infer<typeof matchingConfigSchema>;

/** Prefer the vendor-neutral name. An empty value falls through to the deprecated JEV_* alias. */
function setting(env: NodeJS.ProcessEnv, name: string, alias: string): string | undefined {
  const primary = env[name];
  if (primary !== undefined && primary !== '') return primary;
  return env[alias];
}

function flag(env: NodeJS.ProcessEnv, name: string, alias: string): boolean | string {
  const raw = setting(env, name, alias);
  if (raw === undefined || raw === '') return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

/** Shared workflow configuration for Telegram, Studio and read-only evaluation. */
export function loadMatchingConfig(env: NodeJS.ProcessEnv = process.env): MatchingConfig {
  const parsed = matchingConfigSchema.safeParse({
    largeClientSearch: flag(env, 'MATCHER_LARGE_CLIENT_SEARCH', 'JEV_LARGE_CLIENT_SEARCH'),
    mode: setting(env, 'MATCHER_MODE', 'JEV_MODE'),
    model: setting(env, 'MATCHER_MODEL', 'JEV_MODEL'),
    timeoutMs: setting(env, 'MATCHER_TIMEOUT_MS', 'JEV_TIMEOUT_MS'),
    maxRetries: setting(env, 'MATCHER_MAX_RETRIES', 'JEV_MAX_RETRIES'),
  });
  if (!parsed.success) throw new Error('Invalid matching configuration');
  if (parsed.data.mode !== 'off' && !env.TYPESAFE_API_KEY?.trim()) {
    throw new Error('TYPESAFE_API_KEY is required when matching is enabled');
  }
  return parsed.data;
}
