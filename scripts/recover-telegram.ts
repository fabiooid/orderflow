import { loadConfig } from '../src/config/load.js';
import { TelegramApi } from '../src/telegram/api.js';
import { TelegramStore } from '../src/telegram/store.js';
import { acquirePollerLock } from '../src/telegram/lock.js';
async function main() {
  const [idText, action, messageText] = process.argv.slice(2);
  const id = Number(idText); const message = Number(messageText);
  if (!idText || !Number.isSafeInteger(id) || id < 0 || !['delivered', 'not-delivered'].includes(action ?? '') || (action === 'delivered' && (!Number.isSafeInteger(message) || message <= 0))) {
    throw new Error('Usage: telegram:recover -- UPDATE_ID delivered MESSAGE_ID | UPDATE_ID not-delivered');
  }
  const config = await loadConfig(process.env.APP_CONFIG_PATH ?? 'config/example.json');
  const mode = process.env.CONNECTOR_MODE ?? 'demo';
  if (!['demo', 'read-only'].includes(mode)) throw new Error('Invalid connector mode');
  const me = await new TelegramApi(process.env.TELEGRAM_BOT_TOKEN ?? '').getMe();
  const unlock = await acquirePollerLock(`.data/telegram-${config.deploymentId}.lock`);
  const store = new TelegramStore('file:.data/telegram.db', `${config.deploymentId}:${config.telegram.groupId}:${mode}:${me.id}`);
  try {
    await store.init();
    if (!(await store.update(id))?.sending) throw new Error('No uncertain delivery exists for this update');
    if (action === 'delivered') await store.sent(id, message);
    else await store.retrySend(id);
    console.log('Local delivery record updated. Restart the poller to continue. No message sent by recovery.');
  } finally { store.close(); await unlock(); }
}
main().catch(() => { console.error('Recovery failed. Check arguments, stop the poller and inspect the uncertain delivery before retrying.'); process.exitCode = 1; });
