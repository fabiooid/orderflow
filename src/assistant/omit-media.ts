import type { AnySpan, SpanOutputProcessor } from '@mastra/core/observability';

const OMITTED = '[media omitted]';
/** Long unbroken base64, as images and audio appear once serialized. Ordinary text has spaces and punctuation. */
const base64 = /^[A-Za-z0-9+/=\r\n]{2000,}$/;

/** A copy with file bytes replaced; the original objects may still be in use by the running agent. */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return OMITTED;
  if (typeof value === 'string') return value.startsWith('data:') && value.includes(';base64,') || base64.test(value) ? OMITTED : value;
  if (Array.isArray(value)) return value.length > 256 && value.every(v => typeof v === 'number') ? OMITTED : value.map(v => scrub(v, depth + 1));
  // A Buffer serialized to JSON.
  if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'Buffer' && Array.isArray((value as { data?: unknown }).data)) return OMITTED;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, depth + 1)]));
  }
  return value;
}

/**
 * Keeps photos, scans and voice notes out of stored traces: spans keep the text around them, not the file bytes.
 * Media readers have no memory and the order-form workflow keeps no snapshots, so this is the last place files could land.
 */
export const omitMedia: SpanOutputProcessor = {
  name: 'omit-media',
  process(span?: AnySpan) {
    if (!span) return span;
    span.input = scrub(span.input);
    span.output = scrub(span.output);
    if (span.attributes) span.attributes = scrub(span.attributes) as typeof span.attributes;
    if (span.metadata) span.metadata = scrub(span.metadata) as typeof span.metadata;
    return span;
  },
  async shutdown() {},
};
