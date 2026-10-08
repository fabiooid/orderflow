import { z } from 'zod';

export const matchingConfigSchema = z.object({
  mode: z.enum(['off', 'shadow', 'on']).default('off'),
  model: z.string().trim().min(1).default('jev-1.13.0'),
  timeoutMs: z.coerce.number().int().min(100).max(60000).default(15000),
  maxRetries: z.coerce.number().int().min(0).max(2).default(1),
}).strict();
export type MatchingConfig = z.infer<typeof matchingConfigSchema>;

/** Foundation configuration only; Telegram/Studio activation is a later phase. */
export function loadMatchingConfig(env: NodeJS.ProcessEnv = process.env): MatchingConfig {
  const parsed = matchingConfigSchema.safeParse({
    mode: env.JEV_MODE, model: env.JEV_MODEL,
    timeoutMs: env.JEV_TIMEOUT_MS, maxRetries: env.JEV_MAX_RETRIES,
  });
  if (!parsed.success) throw new Error('Invalid JEV configuration');
  if (parsed.data.mode !== 'off' && !env.TYPESAFE_API_KEY?.trim()) {
    throw new Error('TYPESAFE_API_KEY is required when JEV_MODE is enabled');
  }
  return parsed.data;
}
