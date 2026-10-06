import { loadConfig } from '../src/config/load.js';
import { FattureInCloudConnector } from '../src/connector/fatture-in-cloud.js';
import { TelegramApi } from '../src/telegram/api.js';
import { liveHealthPorts } from '../src/health/ports.js';
async function main() {
  const [flag, value] = process.argv.slice(2);
  const id = Number(value);
  if (flag !== '--order' || !Number.isSafeInteger(id) || id <= 0) throw new Error();
  const config = await loadConfig(process.env.APP_CONFIG_PATH ?? 'config/example.json');
  const permissions = await liveHealthPorts(config, process.env).telegram();
  if (!permissions.member || !permissions.canSend) throw new Error();
  const connector = FattureInCloudConnector.fromToken(config.companyId, process.env.FIC_ACCESS_TOKEN ?? '');
  const order = await connector.getOrder(id);
  if (!order.url) throw new Error();
  // No order write, no customer email, no model-supplied URL or destination.
  await new TelegramApi(process.env.TELEGRAM_BOT_TOKEN ?? '').sendOrderPdf(config.telegram.groupId, order.url, `Order ${order.number} — internal review`);
  console.log('Existing order PDF posted to the configured internal group. No order modified or customer email sent.');
}
main().catch(() => {
  console.error('PDF delivery not confirmed. Check the group before retrying; use --order with the API document ID, not its printed order number.');
  process.exitCode = 1;
});
