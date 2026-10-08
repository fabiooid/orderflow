import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Mastra } from '@mastra/core';
import { runEvals } from '@mastra/core/evals';
import { z } from 'zod';
import { loadAppConfig } from '../src/config/load.js';
import { orderFormScorers } from '../src/assistant/order-form-scorers.js';
import { createMediaAgents, modelVision } from '../src/telegram/media.js';
import { createOrderFormWorkflow, scannedPages } from '../src/telegram/order-forms.js';

/**
 * Runs the `read-order-form` workflow on filled-in forms whose correct order is known and scores it with Mastra
 * scorers. Makes model calls. Datasets hold real documents, so keep them out of git.
 */
const datasetSchema = z.array(z.object({ name: z.string(), file: z.string(), page: z.number().int().min(1).default(1), expected: z.record(z.string(), z.number()) }));

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { runs: { type: 'string', default: '1' } } });
  const dataset = datasetSchema.parse(JSON.parse(await readFile(positionals[0] ?? 'private/evals/order-forms.json', 'utf8')));
  const config = await loadAppConfig();
  if (!config.orderForms.length) throw new Error('No order forms configured; list your templates under orderForms first.');
  const { formReader } = createMediaAgents(config);
  const mastra = new Mastra({
    agents: { formReader }, workflows: { readOrderForm: createOrderFormWorkflow(config.orderForms, modelVision(formReader)) },
    scorers: Object.fromEntries(Object.values(orderFormScorers).map(scorer => [scorer.id, scorer])),
  });
  const data = await Promise.all(dataset.map(async item => {
    const file = await readFile(item.file);
    const page = item.file.toLowerCase().endsWith('.pdf') ? (await scannedPages(file))[item.page - 1] : file;
    if (!page) throw new Error(`${item.name}: no scanned page ${item.page}`);
    return { input: { page }, groundTruth: item.expected };
  }));
  for (let run = 1; run <= Number(values.runs); run++) {
    const result = await runEvals({
      target: mastra.getWorkflow('readOrderForm'), data, scorers: Object.values(orderFormScorers),
      onItemComplete: ({ item, targetResult, scorerResults }) => {
        const name = dataset[data.indexOf(item as (typeof data)[number])]?.name;
        const silent = scorerResults['order-form-no-silent-errors'];
        // How many products each reading found: an empty reading turns every line into a question.
        const steps = (targetResult as { scoringData?: { stepResults?: typeof targetResult.steps } }).scoringData?.stepResults ?? targetResult.steps ?? {};
        const found = ['read-1', 'read-2'].map(id => { const step = steps[id]; return step?.status === 'success' ? Object.keys((step.output as { ordered: object }).ordered).length : step?.status; });
        console.log(`run ${run} · ${name}: no silent errors ${silent?.score?.toFixed(2)}, coverage ${scorerResults['order-form-coverage']?.score?.toFixed(2)} (readings found ${found.join(' and ')} products) — ${silent?.reason ?? ''}`);
      },
    });
    console.log(`run ${run} averages: ${Object.entries(result.scores).map(([id, score]) => `${id} ${Number(score).toFixed(2)}`).join(', ')}`);
  }
}

main().catch(error => {
  // SDK and model errors can carry authorization headers; never print them.
  console.error(`Evaluation failed: ${error instanceof Error && !('config' in error) ? error.message : 'check APP_CONFIG_PATH, credentials and connectivity'}`);
  process.exitCode = 1;
});
