import { describe, expect, it } from 'vitest';
import { prepareOrder } from '../src/domain/prepare.js';
import { draftSchema } from '../src/domain/types.js';
import { DemoConnector } from '../src/connector/demo.js';
import { orderDraft } from '../src/channel/preview.js';
import { config, draft } from './helpers.js';

const prepare = (amount: number, basis: 'net' | 'gross' | 'unclear' = 'net', decision: 'pending' | 'catalogue' | 'document' = 'pending') =>
  prepareOrder(draftSchema.parse({ ...draft(), lines: [{ ...draft().lines[0], netPrice: amount, documentPrice: { amount, basis, decision } }] }), config(), new DemoConnector(), '2026-01-15');

describe('document prices require clarification', () => {
  it('blocks a differing printed price even if extraction also copied it to netPrice', async () => {
    const result = await prepare(9);
    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.issues[0]).toMatchObject({ field: 'lines.0.documentPrice', priceComparison: { document: 9, catalogue: 12 } });
    // The agent reads both prices from the API; the draft marks the line whose price needs an answer.
    expect(result.issues[0]!.message).toContain('9 EUR');
    expect(result.issues[0]!.message).toContain('12 EUR');
    expect(orderDraft(result.draft, result.issues, true)).toContain('❓ Da completare: prezzo di Pebble hand wash 250 ml');
  });
  it('uses current FiC prices when the operator chooses catalogue', async () => {
    const result = await prepare(9, 'net', 'catalogue');
    expect(result.ready && result.order.lines[0]?.netPrice).toBe(12);
  });
  it('applies a confirmed document net price only to this order', async () => {
    const result = await prepare(9, 'net', 'document');
    expect(result.ready && result.order.lines[0]?.netPrice).toBe(9);
    const next = await prepareOrder(draft(), config(), new DemoConnector(), '2026-01-15');
    expect(next.ready && next.order.lines[0]?.netPrice).toBe(12);
  });
  it('needs no question when a net reference price equals FiC', async () => {
    expect((await prepare(12)).ready).toBe(true);
  });
  it.each(['gross', 'unclear'] as const)('never treats a %s price as net even when numerically equal', async basis => {
    expect((await prepare(12, basis)).ready).toBe(false);
    expect((await prepare(12, basis, 'document')).ready).toBe(false);
  });
});
