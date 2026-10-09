import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { Observability, MastraStorageExporter } from '@mastra/observability';
import { connectorMode, loadConfig } from '../config/load.js';
import { telegramMemoryUrl } from '../telegram/store.js';
import { FattureInCloudConnector } from '../connector/fatture-in-cloud.js';
import { DemoConnector } from '../connector/demo.js';
import { createOrderAgent } from '../assistant/agent.js';
import { createOrderWorkflow } from '../assistant/workflow.js';
import { exactOrderScorer } from '../assistant/scorers.js';
import { liveEvalSettings } from '../assistant/live-evals.js';
import { createDeliveredReplyWorkflow } from '../telegram/evaluation.js';
import { createMediaAgents, modelVision } from '../telegram/media.js';
import { createOrderFormWorkflow } from '../telegram/order-forms.js';
import { omitMedia } from '../assistant/omit-media.js';
import { orderFormScorers } from '../assistant/order-form-scorers.js';

// Studio follows the configured catalogue mode. Live writes remain disabled.
let projectRoot = process.cwd();
while (!existsSync(resolve(projectRoot, 'package.json')) || JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')).name !== 'orderflow') {
  const parent = dirname(projectRoot);
  if (parent === projectRoot) throw new Error('Cannot locate application root');
  projectRoot = parent;
}
const config = await loadConfig(resolve(projectRoot, process.env.APP_CONFIG_PATH ?? 'config/example.json'), projectRoot);
await mkdir(resolve(projectRoot, '.data'), { recursive: true });
const mode = connectorMode();
// Resolve before Studio changes cwd to its public directory. LibSQL opens lazily.
const configuredUrl = mode === 'demo' ? (process.env.MASTRA_DATABASE_URL ?? 'file:.data/mastra.db') : telegramMemoryUrl(config, mode);
const storageUrl = configuredUrl.startsWith('file:') && !configuredUrl.startsWith('file:/')
  ? pathToFileURL(resolve(projectRoot, configuredUrl.slice(5))).href : configuredUrl;
const storage = new LibSQLStore({ id: 'assistant-storage', url: storageUrl });
const connector = mode === 'read-only' ? FattureInCloudConnector.fromToken(config.companyId, process.env.FIC_ACCESS_TOKEN ?? '') : new DemoConnector();
const live = liveEvalSettings();
const { agent, extract, matching, scorers: manualScorers } = createOrderAgent(config, connector, storage, live);
const workflow = createOrderWorkflow(config, connector, extract, undefined, matching);
const deliveredReply = createDeliveredReplyWorkflow(manualScorers, live);
// The media readers and the order-form workflow can be tried and inspected in Studio too.
const { mediaReader, formReader } = createMediaAgents(config);
const readOrderForm = createOrderFormWorkflow(config.orderForms, modelVision(formReader));
export const mastra = new Mastra({
  observability: new Observability({ configs: { default: { serviceName: 'orderflow', exporters: [new MastraStorageExporter()], spanOutputProcessors: [omitMedia] } } }),
  storage, agents: { orderAssistant: agent, mediaReader, formReader }, workflows: { prepareOrder: workflow, deliveredReply, readOrderForm },
  scorers: Object.fromEntries([exactOrderScorer, ...Object.values(orderFormScorers), ...Object.values(manualScorers)].map(scorer => [scorer.id, scorer])),
});
