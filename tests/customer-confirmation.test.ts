import { expect, it } from 'vitest';
import { draftSchema } from '../src/domain/types.js';
import { DemoConnector } from '../src/connector/demo.js';
import { conversationCases, evalConnector, maplePine } from '../src/evals/conversations.js';
import { runConversation, scriptedTurns } from '../src/evals/harness.js';
import type { Converse } from '../src/channel/engine.js';
import { prepareOrder } from '../src/domain/prepare.js';
import { config, draft } from './helpers.js';

const productsAndNote = {
  lines: [{ query: 'Pebble hand wash 250 ml', quantity: 2 }],
  shippingPrice: 8,
  notes: 'express',
};

function withMaple() {
  const demo = new DemoConnector();
  demo.clients.push(maplePine);
  return demo;
}

/** A scripted model that treats a unique close account as found, then only fills products, shipping and a note. */
function weakThenFill(): Converse {
  return async (prompt, act) => {
    if (!prompt.openRequest) {
      await act.order(draftSchema.parse({ clientQuery: 'Maple', clientId: maplePine.id }));
      return { reply: 'Trovato Maple & Pine Trading Ltd.', locale: 'it' };
    }
    await act.order(draftSchema.parse({
      clientQuery: maplePine.name,
      clientId: maplePine.id,
      ...productsAndNote,
    }));
    return { reply: '', locale: 'it' };
  };
}

it('offers a single weak customer as a question, not as found, and does not lock it on a products-only follow-up', async () => {
  const outcome = await runConversation(config(), withMaple(), [
    { text: 'ordine per Maple' },
    { text: '2 Pebble hand wash 250 ml, spedizione 8 euro, nota: express' },
  ], { converse: weakThenFill() });
  const open = outcome.open;
  const clientIssue = open?.issues?.find(issue => issue.field === 'client');
  const last = outcome.replies.at(-1) ?? '';
  expect(open?.draft.clientId).toBeUndefined();
  expect(open?.status).toBe('suspended');
  expect(open?.prepared).toBeUndefined();
  expect(clientIssue?.candidates?.some(c => c.id === maplePine.id)).toBe(true);
  expect(last).toMatch(/🏪 Maple(?: & Pine Trading Ltd)? ❓/);
  expect(last).not.toMatch(/🏪 Maple & Pine Trading Ltd\n/);
  expect(open?.draft.lines.some(line => line.query === 'Pebble hand wash 250 ml' && line.quantity === 2)).toBe(true);
  expect(open?.draft.shippingPrice).toBe(8);
  expect(open?.draft.notes).toBe('express');
});

it('covers the same conversation through the shared scripted eval cases', async () => {
  for (const id of ['weak-customer-stays-unmatched', 'exact-customer-name-locks']) {
    const scenario = conversationCases.find(c => c.id === id);
    expect(scenario?.scripted, id).toBeTruthy();
    const outcome = await runConversation(config(), evalConnector(), scenario!.turns, { converse: scriptedTurns(scenario!.scripted!) });
    expect(scenario!.check(outcome), id).toEqual([]);
  }
});

it('still selects an exact customer name the operator just typed', async () => {
  const converse: Converse = async (_prompt, act) => {
    await act.order(draftSchema.parse({ clientQuery: maplePine.name, ...productsAndNote }));
    return { reply: '', locale: 'it' };
  };
  const outcome = await runConversation(config(), withMaple(), [
    { text: 'ordine per Maple & Pine Trading Ltd: 2 Pebble hand wash 250 ml, spedizione 8 euro' },
  ], { converse });
  expect(outcome.open?.status).toBe('ready');
  expect(outcome.open?.prepared?.client.id).toBe(maplePine.id);
});

it('does not treat a unique close account as already chosen when preparing an order', async () => {
  const demo = withMaple();
  const weak = await prepareOrder({ ...draft(), clientQuery: 'Maple' }, config(), demo, '2026-01-15');
  expect(weak.ready).toBe(false);
  if (weak.ready) return;
  expect(weak.draft.clientId).toBeUndefined();
  expect(weak.clientId).toBeUndefined();
  expect(weak.issues.find(issue => issue.field === 'client')?.candidates?.map(c => c.id)).toEqual([maplePine.id]);
  const rewritten = await prepareOrder({ ...draft(), clientQuery: maplePine.name }, config(), demo, '2026-01-15', undefined, 'ordine per Maple');
  expect(rewritten.ready).toBe(false);
  if (!rewritten.ready) expect(rewritten.issues.find(issue => issue.field === 'client')?.candidates?.map(c => c.id)).toEqual([maplePine.id]);
  const exact = await prepareOrder({ ...draft(), clientQuery: maplePine.name }, config(), demo, '2026-01-15', undefined, 'ordine per Maple & Pine Trading Ltd');
  expect(exact.ready && exact.order.client.id).toBe(maplePine.id);
  const picked = await prepareOrder({ ...draft(), clientQuery: 'Maple', clientId: maplePine.id }, config(), demo, '2026-01-15');
  expect(picked.ready && picked.order.client.id).toBe(maplePine.id);
});
