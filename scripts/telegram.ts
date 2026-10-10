import { setTimeout as delay } from 'node:timers/promises';
import { tracedConnector, traceOperation } from '../src/assistant/execution-trace.js';
import { turnCachedConnector, withTurnCache } from '../src/connector/turn-cache.js';
import type { OrderConnector } from '../src/connector/contract.js';
import { orderCreator } from '../src/channel/order.js';
import { telegramTraces } from '../src/channels/telegram/traces.js';
import { customerCreator } from '../src/channel/customer.js';
import { WriteJournal } from '../src/storage/write-journal.js';
import { mkdir } from 'node:fs/promises';
import { LibSQLStore } from '@mastra/libsql';
import { connectorMode, loadAppConfig } from '../src/config/load.js';
import { TelegramApi } from '../src/channels/telegram/api.js';
import { TELEGRAM_STATE_URL, TelegramStore, pollerLockPath, telegramMemoryUrl, telegramScopePrefix } from '../src/channel/store.js';
import { TelegramController } from '../src/channel/controller.js';
import { createConversationEngine } from '../src/channel/engine.js';
import { wireMatching } from '../src/matching/wire.js';
import { acquirePollerLock } from '../src/channels/telegram/lock.js';
import { albumOf, groupAlbums, installTelegramChannel } from '../src/channels/telegram/adapter.js';
import { DemoConnector } from '../src/connector/demo.js';
import { FattureInCloudConnector } from '../src/connector/fatture-in-cloud.js';
import { checkConnections } from '../src/health/check.js';
import { liveHealthPorts } from '../src/health/ports.js';

async function main() {
  const config = await loadAppConfig();
  const mode = connectorMode();
  const fic = (options?: { writesEnabled?: boolean; clientWritesEnabled?: boolean }) => FattureInCloudConnector.fromToken(config.invoicing.companyId, process.env.FIC_ACCESS_TOKEN ?? '', options);
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
  const unlock = await acquirePollerLock(pollerLockPath(config));
  const store = new TelegramStore(TELEGRAM_STATE_URL, `${telegramScopePrefix(config, mode)}${me.id}`);
  const storage = new LibSQLStore({ id: 'telegram-memory', url: telegramMemoryUrl(config, mode) });
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
    const connector = turnCachedConnector(tracedConnector(mode === 'demo' ? new DemoConnector() : fic()));
    // Model work and form reading take from seconds to about a minute: keep "typing…" visible meanwhile.
    // Only around engine calls, so chatter the bot ignores never shows it, nor triggers the list reads started here.
    const typing = async <T>(work: () => Promise<T>) => {
      connector.prefetch();
      const show = () => { api.typing(config.channel.groupId).catch(() => undefined); };
      show();
      const timer = setInterval(show, 4500);
      try { return await work(); } finally { clearInterval(timer); }
    };
    installTelegramChannel();
    const untyped = createConversationEngine(config, connector, storage, { threadTitle: 'OrderFlow Telegram group', matching: wireMatching() });
    const engine = { ...untyped, turn: (input: Parameters<typeof untyped.turn>[0]) => typing(() => untyped.turn(input)),
      revise: (...args: Parameters<typeof untyped.revise>) => typing(() => untyped.revise(...args)) };
    engineShutdown = engine.shutdown;
    const readMedia = engine.media((id, max) => traceOperation('Telegram download media', () => api.download(id, max)));
    const orderConnector: OrderConnector = mode === 'demo' ? connector : tracedConnector(fic({ writesEnabled: config.orderSavingEnabled }));
    const controller = new TelegramController(config, me.username, store, engine, (text, reply, keyboard) => traceOperation('Telegram deliver text', () => api.sendText(config.channel.groupId, text, reply, keyboard)), mode === 'read-only' ? customerCreator(config, tracedConnector(fic({ clientWritesEnabled: true })), journal) : undefined,
      mode === 'read-only' && config.orderSavingEnabled ? orderCreator(config, orderConnector, journal) : undefined,
      async (id, locale = config.locale) => {
        const saved = await orderConnector.getOrder(id);
        if (!saved.url) throw new Error('Saved order PDF not available; reconcile delivery without recreating order');
        return traceOperation('Telegram deliver order PDF', () => api.sendOrderPdf(config.channel.groupId, saved.url!, `${locale === 'it' ? 'Ordine' : 'Order'} ${saved.number}`), { orderId: id });
      }, {answer: id => api.answerCallback(id), clear: id => api.clearButtons(config.channel.groupId, id)},
      (event, locale) => typing(() => readMedia(event, locale)));
    console.log(`OrderFlow Telegram ${mode} running. Saving needs the confirmation button. Order saving: ${config.orderSavingEnabled ? 'enabled' : 'disabled'}. Stop with Ctrl+C.`);
    while (!stopping) {
      let updates: { update_id: number }[];
      try {
        const offset = await store.offset();
        updates = await api.updates(offset);
        // Album photos arrive as separate updates; give the rest of an album a moment to arrive with its first part.
        if (albumOf(updates.at(-1)) !== undefined) { await delay(1500); updates = await api.updates(offset); }
      } catch {
        if (stopping) break;
        console.warn('Telegram polling unavailable; retrying the read in 5 seconds. No writes retried.');
        await delay(5000);
        continue;
      }
      for (const [update, ...album] of groupAlbums(updates)) {
        if (stopping) break;
        await withTurnCache(() => engine.traceTurn(update!.update_id, async () => {
          await controller.handle(update!, album);
          const entry = await store.update(update!.update_id);
          return { orderId: entry?.plan.order?.orderId, revision: entry?.plan.order?.revision, state: entry?.plan.order?.status, activeOrderId: entry?.plan.activeOrderId, cancelled: entry?.plan.cancelled?.length, delivered: entry?.done ?? false };
        }));
        try { await traces.sync(store, update!.update_id); } catch { console.warn('Trace export failed; Telegram state remains stored for later import.'); }
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
  const safe = error instanceof Error && /^(CONNECTOR_MODE|A Telegram poller|Channel delivery|Telegram delivery|Telegram getUpdates|Telegram send|Telegram group checks|Account checks|TELEGRAM_BOT_TOKEN)/.test(error.message);
  console.error(safe ? error.message : 'Telegram stopped. Check config/credentials and local state; inspect write and delivery state before retrying.');
  process.exitCode = 1;
});
