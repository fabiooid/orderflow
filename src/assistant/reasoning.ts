/**
 * Per-call reasoning budget. Most of a call's latency was hidden reasoning at the model's default effort.
 * Models without the requested effort ignore it (the provider drops it with a warning) and use their default.
 */
export const reasoning = (effort: 'low' | 'medium') => ({ openai: { reasoningEffort: effort } });
