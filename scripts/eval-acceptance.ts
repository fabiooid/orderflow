import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Mastra } from '@mastra/core';
import { runEvals } from '@mastra/core/evals';
import { LibSQLStore } from '@mastra/libsql';
import { acceptanceCases, acceptanceScorer, createAcceptanceWorkflow } from '../src/assistant/acceptance.js';
import { createOrderAgent } from '../src/assistant/agent.js';
import { DemoConnector } from '../src/connector/demo.js';
import { loadConfig } from '../src/config/load.js';
import type { OrderDraft } from '../src/domain/types.js';

const { values } = parseArgs({ options: { offline: { type: 'boolean' }, case: { type: 'string' } } });
const directory = await mkdtemp(join(tmpdir(), 'orderflow-acceptance-'));
const storage = new LibSQLStore({ id: 'acceptance', url: `file:${join(directory, 'memory.db')}` });
let mastra: Mastra | undefined;
try {
  const config = await loadConfig('config/example.json'); // Always fictional, regardless of APP_CONFIG_PATH.
  config.model = process.env.EVAL_AGENT_MODEL ?? config.model;
  const connector = new DemoConnector();
  const { agent, extract } = createOrderAgent(config, connector, storage);
  const turns = new Map<string, number>();
  const drafts = new Map<string, OrderDraft>();
  const cases = values.case ? acceptanceCases.filter(c => c.id === values.case) : acceptanceCases;
  if (!cases.length) throw new Error('Unknown case');
  const workflow = createAcceptanceWorkflow(config, connector, values.offline ? async (_text, id) => {
    const index = turns.get(id) ?? 0; turns.set(id, index + 1);
    return structuredClone(acceptanceCases.find(c => `acceptance-${c.id}` === id)!.scripted[index]!);
  } : extract, (id, draft) => drafts.set(id, draft));
  mastra = new Mastra({ storage, agents: { orderAssistant: agent }, workflows: { acceptance: workflow }, scorers: { acceptanceScorer } });
  console.log(values.offline ? 'Offline: scripted extraction; tests application behavior, not model accuracy.' : `Live extraction using ${config.model}; model charges apply. Fictional catalogue only, no FIC writes or Telegram messages.`);
  const results = await runEvals({ target: mastra.getWorkflow('acceptance'), data: cases.map(c => ({ input: { scenarioId: c.id }, groundTruth: c.expected })), scorers: [acceptanceScorer],
    onItemComplete: ({ item, scorerResults }) => {
      console.log(`${item.input.scenarioId}: ${scorerResults[acceptanceScorer.id]?.score} — ${scorerResults[acceptanceScorer.id]?.reason}`);
      if (scorerResults[acceptanceScorer.id]?.score !== 1) console.log(`Fictional extracted draft: ${JSON.stringify(drafts.get(item.input.scenarioId))}`);
    },
  });
  if (results.scores[acceptanceScorer.id] !== 1) process.exitCode = 1;
} catch {
  console.error('Acceptance run failed; check model configuration and connectivity. No business records were written.'); process.exitCode = 1;
} finally { await mastra?.shutdown(); await storage.close(); await rm(directory, { recursive: true, force: true }); }
