import { expect, it } from 'vitest';
import type { AnySpan } from '@mastra/core/observability';
import { omitMedia } from '../src/assistant/omit-media.js';

it('strips file bytes from traced spans without touching the objects the agent still uses', () => {
  const image = Buffer.alloc(5000, 1);
  const message = { role: 'user', content: [{ type: 'text', text: 'Read this form.' }, { type: 'image', image, mediaType: 'image/png' }] };
  const span = { input: [message], output: { text: 'DEMO-A | 3', file: `data:image/png;base64,${'A'.repeat(3000)}` }, attributes: { raw: 'Q'.repeat(2500) }, metadata: { json: JSON.parse(JSON.stringify(image)) } } as unknown as AnySpan;
  omitMedia.process(span);
  expect(span.input).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Read this form.' }, { type: 'image', image: '[media omitted]', mediaType: 'image/png' }] }]);
  expect(span.output).toEqual({ text: 'DEMO-A | 3', file: '[media omitted]' });
  expect(span.attributes).toEqual({ raw: '[media omitted]' });
  expect(span.metadata).toEqual({ json: '[media omitted]' });
  expect(message.content[1]).toMatchObject({ image });
});
