import { afterEach, expect, it, vi } from 'vitest';
import { LibSQLStore } from '@mastra/libsql';
import { evaluateScoringPredicate } from '@mastra/core/evals';
import { liveAgentScorers, liveEvalSettings } from '../src/assistant/live-evals.js';
import { createManualScorers } from '../src/assistant/manual-scorers.js';
import { createConversationEngine } from '../src/channel/engine.js';
import { DemoConnector } from '../src/connector/demo.js';
import { config } from './helpers.js';
import { draftSchema } from '../src/domain/types.js';

const observed = vi.hoisted(() => ({ calls: [] as { id: string; input: any; output: any }[], fail: false, wait: undefined as Promise<void> | undefined }));
vi.mock('../src/assistant/manual-scorers.js', async () => {
  const { createScorer } = await import('@mastra/core/evals');
  const make = (id: string, type: 'agent' | 'trajectory' = 'agent') => createScorer({ id, description: id, type })
    .generateScore(async ({ run }) => {
      observed.calls.push({ id, input: run.input, output: run.output });
      await observed.wait;
      if (observed.fail) throw new Error('offline judge failure');
      return 1;
    }).generateReason(() => 'offline test verdict');
  return { createManualScorers: () => ({
    toolCallAccuracy: make('tool-call-accuracy'), workflowAdherence: make('workflow-adherence', 'trajectory'),
    conciseness: make('conciseness'), languageConsistency: make('language-consistency'),
    contextRetention: make('context-retention'), userReportedMistakes: make('user-reported-mistakes'),
  }) };
});
afterEach(() => { vi.unstubAllEnvs(); observed.calls.length = 0; observed.fail = false; observed.wait = undefined; });

it('scores Telegram agent turns for tool use, and their wording only on the delivered reply', () => {
  const bindings = liveAgentScorers(createManualScorers([]), { enabled: true, rate: 0.5 });
  const eligible = (key: string, requestContext: Record<string, string>) => evaluateScoringPredicate(bindings[key]!.filter!, { requestContext });
  expect(eligible('conciseness', { evalChannel: 'telegram', evalPurpose: 'turn' })).toBe(false);
  expect(eligible('languageConsistency', { evalChannel: 'telegram', evalPurpose: 'turn' })).toBe(false);
  expect(bindings.toolCallAccuracy!.filter).toBeUndefined();
  expect(eligible('conciseness', {})).toBe(true); // Studio's normal chat
  expect(bindings.conciseness!.sampling).toEqual({ type: 'ratio', rate: 0.5 });
  expect(liveAgentScorers(createManualScorers([]), { enabled: false, rate: 1 })).toEqual({});
  expect(liveEvalSettings({})).toEqual({ enabled: true, rate: 0.1 });
  expect(() => liveEvalSettings({ EVALS_SAMPLE_RATE: '2' })).toThrow();
  expect(() => liveEvalSettings({ EVALS_ENABLED: 'perhaps' })).toThrow();
});

it('native workflow attachments persist scores from delivered text, retain history and avoid replay charges', async () => {
  vi.stubEnv('EVALS_ENABLED', 'true'); vi.stubEnv('EVALS_SAMPLE_RATE', '1');
  const storage = new LibSQLStore({ id: 'live-eval-test', url: ':memory:' });
  const c = config();
  const engine = createConversationEngine(c, new DemoConnector(), storage);
  try {
    await engine.record!(1, { incomingText: 'Five soaps please', senderId: '5', texts: ['Order: five soaps'], agentText: 'Order: five soaps', replyTo: 1 });
    await vi.waitFor(() => expect(observed.calls).toHaveLength(5));
    const scores = await storage.getStore('scores');
    await vi.waitFor(async () => {
      const rows = await scores!.listScoresByScorerId({ scorerId: 'telegram-conciseness', pagination: { page: 0, perPage: 10 } });
      expect(rows.scores).toHaveLength(1);
      expect(rows.scores[0]!.score).toBe(1);
    });
    await engine.record!(2, { incomingText: 'No, the address is wrong', senderId: '7', texts: ['Please provide the corrected address'], replyTo: 2,
      order: { orderId: 'o1', revision: 2, status: 'saved', draft: draftSchema.parse({}), policy: 'test', savedOrder: { id: '42', number: '1' } },
    });
    await vi.waitFor(() => expect(observed.calls).toHaveLength(10));
    const correction = observed.calls.filter(c => c.id === 'user-reported-mistakes').at(-1)!;
    expect(correction.input.rememberedMessages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(correction.input.rememberedMessages[1].content.parts[0].text).toBe('Order: five soaps');
    expect(correction.output[0].content.metadata.applicationEvidence.savedOrder.id).toBe('42');
    await engine.record!(2, { incomingText: 'No, the address is wrong', senderId: '7', texts: ['Please provide the corrected address'], replyTo: 2 });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(observed.calls).toHaveLength(10);
  } finally { await engine.shutdown(); await storage.close(); }
});

it('disabling live evaluations retains memory without scheduling any judges', async () => {
  vi.stubEnv('EVALS_ENABLED', 'false');
  const storage = new LibSQLStore({ id: 'disabled-eval-test', url: ':memory:' });
  const engine = createConversationEngine(config(), new DemoConnector(), storage);
  try {
    await engine.record!(1, { incomingText: 'hello', texts: ['Hello'], replyTo: 1 });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(observed.calls).toHaveLength(0);
  } finally { await engine.shutdown(); await storage.close(); }
});


it('delivered replies finish while native background judges are still waiting', async () => {
  vi.stubEnv('EVALS_ENABLED', 'true'); vi.stubEnv('EVALS_SAMPLE_RATE', '1');
  let release!: () => void;
  observed.wait = new Promise<void>(resolve => { release = resolve; });
  const storage = new LibSQLStore({ id: 'async-eval-test', url: ':memory:' });
  const engine = createConversationEngine(config(), new DemoConnector(), storage);
  try {
    await engine.record!(3, { incomingText: 'hello', texts: ['Hello'], replyTo: 3 });
    await vi.waitFor(() => expect(observed.calls).toHaveLength(5));
    const scores = await storage.getStore('scores');
    expect((await scores!.listScoresByScorerId({ scorerId: 'telegram-conciseness', pagination: { page: 0, perPage: 10 } })).scores).toHaveLength(0);
    release();
    await vi.waitFor(async () => expect((await scores!.listScoresByScorerId({ scorerId: 'telegram-conciseness', pagination: { page: 0, perPage: 10 } })).scores).toHaveLength(1));
  } finally { release(); await engine.shutdown(); await storage.close(); }
});

 it('uses matching workflow scorer names and IDs so Studio does not list each twice', async () => {
  const { createDeliveredReplyWorkflow } = await import('../src/channel/evaluation.js');
  const workflow = createDeliveredReplyWorkflow(createManualScorers([]), { enabled: true, rate: 0.1 });
  const scorers = await workflow.listScorers();
  expect(Object.values(scorers)).toHaveLength(5);
  for (const entry of Object.values(scorers)) {
    expect(entry.scorer.name).toBe(entry.scorer.id);
    expect(entry.sampling).toEqual({ type: 'ratio', rate: 0.1 });
  }
});
