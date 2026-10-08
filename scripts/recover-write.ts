import { parseArgs } from 'node:util';
import { connectorMode, loadAppConfig } from '../src/config/load.js';
import { FattureInCloudConnector } from '../src/connector/fatture-in-cloud.js';
import { WriteJournal } from '../src/storage/write-journal.js';
import { TelegramApi } from '../src/telegram/api.js';
import { TelegramStore, TELEGRAM_STATE_URL, telegramScopePrefix, pollerLockPath, journalKey } from '../src/telegram/store.js';
import { acquirePollerLock } from '../src/telegram/lock.js';
import { clientSchema, preparedOrderSchema, totalsSchema } from '../src/domain/types.js';

/** Operator runbook command, intentionally unavailable to the agent. No remote writes or messages. */
async function main() {
  const { positionals: [id, action = 'inspect', remoteId], values } = parseArgs({ allowPositionals: true, options: { evidence: { type: 'string' }, 'verified-absent': { type: 'boolean' } } });
  if (!id || !['inspect', 'found', 'client-found', 'retry'].includes(action)) throw new Error('Use write:recover -- REQUEST_ID inspect|found REMOTE_ID|client-found REMOTE_ID|retry --verified-absent --evidence "verification details"');
  const config = await loadAppConfig();
  const mode = connectorMode();
  if (mode !== 'read-only') throw new Error('Recovery is only for the live connector');
  const me = await new TelegramApi(process.env.TELEGRAM_BOT_TOKEN ?? '').getMe();
  const unlock = await acquirePollerLock(pollerLockPath(config));
  const store = new TelegramStore(TELEGRAM_STATE_URL, `${telegramScopePrefix(config, mode)}${me.id}`);
  const journal = new WriteJournal('file:.data/customer-writes.db');
  try {
    await store.init(); await journal.init();
    const conversation = await store.order(id);
    if (!conversation || conversation.status !== 'saving') throw new Error('No uncertain save for this request');
    const key = `${journalKey(config, id)}:${conversation.kind === 'customer' ? 'customer' : 'confirmed-order'}`;
    if (action === 'inspect') { console.log(JSON.stringify({ request: id, revision: conversation.revision, writes: await journal.inspect(key) }, null, 2)); return; }
    const evidence = values.evidence ?? '';
    if (evidence.trim().length < 10) throw new Error('Supply evidence of your remote inspection');
    if (action === 'retry') {
      if (!values['verified-absent']) throw new Error('Verify every uncertain child write is absent in Fatture in Cloud before approving retry');
      await journal.approveRetry(key, evidence);
    } else {
      const remote = Number(remoteId);
      if (!Number.isSafeInteger(remote) || remote <= 0) throw new Error('Provide the verified remote record ID');
      const connector = FattureInCloudConnector.fromToken(config.companyId, process.env.FIC_ACCESS_TOKEN ?? '');
      if (conversation.kind === 'customer' || action === 'client-found') {
        const expected = clientSchema.parse(conversation.kind === 'customer' ? conversation.draft.newClient : conversation.prepared?.client);
        const client = (await connector.listClients()).find(c => c.id === remote);
        if (!client || Object.entries(expected).some(([field, value]) => (client[field as keyof typeof client] ?? '') !== (value ?? ''))) throw new Error('Remote customer differs from the confirmed details');
        const it = config.locale === 'it';
        const message = it ? `Cliente creato: ${client.name} (ID ${client.id}). Nessun ordine o fattura creato; nessuna email inviata.` : `Customer created: ${client.name} (ID ${client.id}). No order or invoice created; no email sent.`;
        if (action === 'client-found' && conversation.kind !== 'customer') {
          await journal.resolve(`${key}:client`, expected, client, evidence);
          console.log('Customer child write reconciled. The order remains blocked: inspect whether an order exists before found/retry recovery.');
          return;
        }
        await journal.resolve(key, expected, message, evidence);
      } else {
        const order = preparedOrderSchema.parse(conversation.prepared), expected = totalsSchema.parse(conversation.totals);
        const saved = await connector.verifySavedOrder(remote, order, expected);
        await journal.resolve(key, { order, expected }, saved, evidence);
      }
    }
    // Journal first: a crash before this update remains safe and can be recovered again.
    const changed = await store.db.execute({ sql: 'UPDATE tg_orders SET state=? WHERE scope=? AND id=? AND state=?', args: [JSON.stringify({ ...conversation, status: 'ready' }), store.scope, id, JSON.stringify(conversation)] });
    if (changed.rowsAffected !== 1) throw new Error('Conversation changed during recovery');
    console.log('Recovery recorded locally. Restart the poller and confirm the existing summary. Found records will be replayed, not recreated. No remote write or message was sent.');
  } finally { journal.close(); store.close(); await unlock(); }
}
main().catch(() => { console.error('Write recovery failed. Stop the poller, check arguments and compare the remote record with the confirmed draft. No remote write was made.'); process.exitCode = 1; });
