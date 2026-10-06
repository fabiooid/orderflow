import { beforeEach, expect, it, vi } from 'vitest';
import type { MastraDBMessage } from '@mastra/core/agent';
import type { ScorerRunInputForAgent } from '@mastra/core/evals';

const observed = vi.hoisted(() => ({ calls: [] as { kind: string; run: any; options: any }[], score: 1 }));
vi.mock('@mastra/evals/scorers/prebuilt', async () => {
  const { createScorer } = await import('@mastra/core/evals');
  const fake = (kind: string) => (options: any) => createScorer({
    id: kind, description: kind, judge: { model: options.model, instructions: 'Offline test stub' },
  }).analyze(({ run }) => {
    observed.calls.push({ kind, run, options });
    return { detail: 'mock judge evidence', score: kind === 'trajectory' ? 0.9 : observed.score };
  }).generateScore(({ results }) => results.analyzeStepResult.score).generateReason(() => 'Mock explanation');
  return {
    createRubricScorer: fake('rubric'), createMultiTurnJudgeScorer: fake('multi-turn'),
    createToolCallAccuracyScorerLLM: fake('tools'), createTrajectoryAccuracyScorerLLM: fake('trajectory'),
  };
});
import { createManualScorers } from '../src/assistant/manual-scorers.js';
import { evidenceMessages, renderEvidence } from '../src/assistant/eval-evidence.js';

function message(id: string, role: MastraDBMessage['role'], text: string): MastraDBMessage {
  return { id, role, createdAt: new Date(0), content: { format: 2, parts: [{ type: 'text', text }] } };
}
function input(current: MastraDBMessage[], history: MastraDBMessage[] = []): ScorerRunInputForAgent {
  return { inputMessages: current, rememberedMessages: history, systemMessages: [], taggedSystemMessages: {} };
}
const tools = [{ id: 'searchProducts', description: 'Search the catalogue' }];
beforeEach(() => { observed.calls.length = 0; observed.score = 1; });

it('registers six distinct manual scorers with an independently configurable judge', () => {
  const scorers = Object.values(createManualScorers(tools));
  expect(new Set(scorers.map(s => s.id)).size).toBe(6);
  expect(scorers.every(s => s.judge?.model === 'openai/gpt-4.1-mini')).toBe(true);
  expect(createManualScorers(tools, 'openai/another-model').conciseness.judge?.model).toBe('openai/another-model');
  expect(() => createManualScorers(tools, 'invalid')).toThrow('provider/model');
  expect(observed.calls).toHaveLength(0);
});

it('skips missing history before calling any judge and preserves not-scorable instead of scoring zero', async () => {
  const scorers = createManualScorers(tools);
  const run = { input: input([message('u', 'user', 'Create an order')]), output: [message('a', 'assistant', 'Which customer?')] };
  for (const scorer of [scorers.contextRetention, scorers.userReportedMistakes]) {
    const result = await scorer.run(run);
    expect(result.notScorable?.reason).toContain('follow-up');
    expect(result.score).toBeUndefined();
  }
  expect(observed.calls).toHaveLength(0);
});

it('passes both user corrections and earlier assistant replies to the multi-turn judge in order', async () => {
  const history = [message('u1', 'user', 'Order five soaps'), message('a1', 'assistant', 'Order: three soaps')];
  const run = { input: input([message('u2', 'user', 'No, you got it wrong: I said five')], history), output: [message('a2', 'assistant', 'Corrected to five')] };
  await createManualScorers(tools).userReportedMistakes.run(run);
  const evidence = JSON.parse(observed.calls[0]!.run.output);
  expect(evidence.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  expect(evidence[2].text).toContain('got it wrong');
  expect(observed.calls[0]!.options.criterion).toContain('Do NOT count overriding a default');
  expect(observed.calls[0]!.options.criterion).toContain('NEVER proof of first-time correctness');
});

it('grades the final prose while carrying language preference and API provenance as evidence', async () => {
  const api = message('tool', 'assistant', '');
  api.content.parts.push({ type: 'tool-invocation', toolInvocation: {
    state: 'result', toolCallId: 'lookup', toolName: 'searchProducts', args: { query: 'ginger' },
    result: [{ name: 'Sapone Zenzero', address: 'Via Roma 1' }],
  } });
  const history = [message('u1', 'user', 'Please reply in English'), api];
  await createManualScorers(tools).languageConsistency.run({
    input: input([message('u2', 'user', 'ok')], history),
    output: [message('a', 'assistant', 'Available: Sapone Zenzero.')],
  });
  const call = observed.calls[0]!;
  expect(call.run.output).toBe('Available: Sapone Zenzero.');
  expect(call.run.input).toContain('Please reply in English');
  expect(call.run.input).toContain('"apiAndToolEvidence":[{"type":"tool-invocation"');
  expect(call.options.criteria[0].description).toContain('Ignore ALL content copied from APIs');
});

it('does not charge for grading structured extraction or tool-only output as conversational style', async () => {
  const scorer = createManualScorers(tools).conciseness;
  const user = input([message('u', 'user', 'Five soaps')]);
  for (const text of ['{"lines":[{"quantity":5}]}', '']) {
    expect((await scorer.run({ input: user, output: [message('a', 'assistant', text)] })).notScorable).toBeDefined();
  }
  expect(observed.calls).toHaveLength(0);
});

it('preserves tool invocations and prior context, allowing a legitimate turn with no tool calls', async () => {
  const output = [message('a', 'assistant', 'Which size?')];
  const result = await createManualScorers(tools).toolCallAccuracy.run({
    input: input([message('u', 'user', 'The same scent')], [message('old', 'user', 'Ginger soap')]), output,
  });
  expect(result.score).toBe(1);
  expect(observed.calls[0]!.run.output).toEqual(output);
  expect(JSON.stringify(observed.calls[0]!.run.input)).toContain('Ginger soap');
  expect(observed.calls[0]!.options.availableTools).toEqual(tools);
});

it('a failed creation-flow rubric cannot be hidden by an otherwise good trajectory score', async () => {
  observed.score = 0;
  const result = await createManualScorers(tools).workflowAdherence.run({
    input: input([message('u', 'user', 'Prepare an order')]),
    output: { steps: [], rawOutput: [message('a', 'assistant', 'I created and sent the invoice')] },
  });
  expect(result.score).toBe(0);
  expect(result.reason).toContain('Creation flow:');
  expect(observed.calls.map(c => c.kind)).toEqual(['trajectory', 'rubric']);
});

it('deduplicates overlapping memory IDs without dropping repeated text from different turns', () => {
  const one = message('one', 'user', 'yes');
  const two = message('two', 'user', 'yes');
  const messages = evidenceMessages(input([one, two], [one]), []);
  expect(messages.map(m => m.id)).toEqual(['one', 'two']);
  expect(JSON.parse(renderEvidence(messages))).toHaveLength(2);
});
