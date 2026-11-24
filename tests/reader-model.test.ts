import { expect, it } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { createMediaAgents } from '../src/channel/media.js';
import { config } from './helpers.js';

it('reads media with readerModel and keeps the chat model separate', async () => {
  const c = { ...config(), model: 'anthropic/claude-haiku-5-5', readerModel: 'openai/gpt-5-mini' };
  const { mediaReader, formReader } = createMediaAgents(c, 'test-key');
  for (const agent of [mediaReader, formReader]) expect((await agent.getModel()).modelId).toBe('gpt-5-mini');
});

it('falls back to model when readerModel is not set, and validates it like model', async () => {
  const { formReader } = createMediaAgents({ ...config(), model: 'openai/gpt-5-mini' }, 'test-key');
  expect((await formReader.getModel()).modelId).toBe('gpt-5-mini');
  const base = configSchema.parse(config());
  expect(() => configSchema.parse({ ...base, readerModel: 'gpt-5-mini' })).toThrow();
  expect(configSchema.parse({ ...base, readerModel: 'openai/gpt-5-mini' }).readerModel).toBe('openai/gpt-5-mini');
});
