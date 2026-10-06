import { setTimeout as delay } from 'node:timers/promises';
import type { OrderConnector } from '../src/connector/contract.js';
import { orderCreator } from '../src/telegram/order.js';
import { telegramTraces } from '../src/telegram/traces.js';
import { customerCreator } from '../src/telegram/customer.js';
import { WriteJournal } from '../src/storage/write-journal.js';
import { mkdir } from 'node:fs/promises';
import { LibSQLStore } from '@mastra/libsql';
import { loadConfig } from '../src/config/load.js';
import { TelegramApi } from '../src/telegram/api.js';
import { TelegramStore } from '../src/telegram/store.js';
import { TelegramController } from '../src/telegram/controller.js';
import { createConversationEngine } from '../src/telegram/engine.js';
import { acquirePollerLock } from '../src/telegram/lock.js';
import { DemoConnector } from '../src/connector/demo.js';
import { FattureInCloudConnector } from '../src/connector/fatture-in-cloud.js';
import { checkConnections } from '../src/health/check.js';
import { liveHealthPorts } from '../src/health/ports.js';

async function main() {
  const config = await loadConfig(process.env.APP_CONFIG_PATH ?? 'config/example.json');
  const mode = process.env.CONNECTOR_MODE ?? 'demo';
  if (mode !== 'demo' && mode !== 'read-only') throw new Error('CONNECTOR_MODE supports demo or read-only only');
  const api = new TelegramApi(process.env.TELEGRAM_BOT_TOKEN ?? '');
  const me = await api.getMe();
  const ports = liveHealthPorts(config, process.env);
  const tg = await ports.telegram();
  if (!tg.member || !tg.canSend || !tg.polling) throw new Error('Telegram group checks failed; run connections:check');
  if (mode === 'read-only') {
    const report = await checkConnections(config, ports);
    if (report.some(c => c.status === 'fail')) throw new Error('Account checks failed; run connections:check');
  }
  await mkdir('.data', { recursive: true });
  // Mode included to keep fictional state separate from account data.
  const scope = `${config.deploymentId}:${config.telegram.groupId}:${mode}:${me.id}`;
  const unlock = await acquirePollerLock(`.data/telegram-${config.deploymentId}.lock`);
  const store = new TelegramStore('file:.data/telegram.db', scope);
  const storage = new LibSQLStore({ id: 'telegram-memory', url: `file:.data/telegram-${config.deploymentId}-${mode}.db` });
  const journal = new WriteJournal('file:.data/customer-writes.db');
  await journal.init();
  const traces = telegramTraces(storage);
  let engineShutdown: (() => Promise<void>) | undefined;
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    await store.init();
    await traces.sync(store);
    const connector = mode === 'demo' ? new DemoConnector() : FattureInCloudConnector.fromToken(config.companyId, process.env.FIC_ACCESS_TOKEN ?? '');
    const engine = createConversationEngine(config, connector, storage, mode);
    engineShutdown = engine.shutdown;
    const orderConnector: OrderConnector = mode === 'demo' ? connector : FattureInCloudConnector.fromToken(config.companyId, process.env.FIC_ACCESS_TOKEN ?? '', { writesEnabled: mode === 'read-only' && config.orderSavingEnabled });
    const controller = new TelegramController(config, me.username, store, engine, (text, reply, keyboard) => api.sendText(config.telegram.groupId, text, reply, keyboard), mode === 'read-only' ? customerCreator(config, FattureInCloudConnector.fromToken(config.companyId, process.env.FIC_ACCESS_TOKEN ?? '', { clientWritesEnabled: true }), journal) : undefined,
      mode === 'read-only' && config.orderSavingEnabled ? orderCreator(config, orderConnector, journal) : undefined,
      async id => {
        const saved = await orderConnector.getOrder(id);
        if (!saved.url) throw new Error('Saved order PDF not available; reconcile delivery without recreating order');
        return api.sendOrderPdf(config.telegram.groupId, saved.url, `Ordine ${saved.number}`);
      }, {answer: id => api.answerCallback(id), clear: id => api.clearButtons(config.telegram.groupId, id)});
    console.log(`OrderFlow Telegram ${mode} running. Customer creation requires /confirmcustomer. Order saving: ${config.orderSavingEnabled ? 'confirmation required' : 'disabled'}. Stop with Ctrl+C.`);
    while (!stopping) {
      let updates: { update_id: number }[];
      try {
        updates = await api.updates(await store.offset());
      } catch {
        if (stopping) break;
        console.warn('Telegram polling unavailable; retrying the read in 5 seconds. No writes retried.');
        await delay(5000);
        continue;
      }
      for (const update of updates) {
        if (stopping) break;
        await controller.handle(update);
        try { await traces.sync(store); } catch { console.warn('Trace export failed; Telegram state remains stored for later import.'); }
      }
    }
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await engineShutdown?.();
    await traces.shutdown();
    journal.close(); store.close(); await storage.close(); await unlock();
  }
}
main().catch(error => {
  // SDK/model exceptions can contain authenticated headers; never dump them.
  const safe = error instanceof Error && /^(Telegram delivery uncertain|CONNECTOR_MODE|A Telegram poller|Telegram delivery|Telegram getUpdates|Telegram send|Telegram group checks|Account checks|TELEGRAM_BOT_TOKEN)/.test(error.message);
  console.error(safe ? error.message : 'Telegram stopped. Check config/credentials and local state; inspect write and delivery state before retrying.');
  process.exitCode = 1;
});
