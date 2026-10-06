import type { AppConfig } from '../config/schema.js';
import type { Product } from '../domain/types.js';

export type Check = { name: string; status: 'pass' | 'fail' | 'manual'; detail: string };
export interface HealthPorts {
  telegram(): Promise<{ member: boolean; canSend: boolean; polling: boolean; readsAll?: boolean }>;
  company(): Promise<boolean>;
  products(): Promise<Product[]>;
  clients(): Promise<unknown[]>;
  vat(): Promise<{ id?: number | null; value?: number | null; ei_type?: string | null; is_disabled?: boolean | null }[]>;
  payments(): Promise<{ id?: number | null }[]>;
}
export async function checkConnections(config: AppConfig, ports: HealthPorts): Promise<Check[]> {
  const checks: Check[] = [];
  async function check(name: string, task: () => Promise<string>) {
    try { checks.push({ name, status: 'pass', detail: await task() }); }
    catch { checks.push({ name, status: 'fail', detail: 'Check credentials, permissions and the configured account references. No writes attempted.' }); }
  }
  let readsAll = true;
  await check('Telegram group', async () => {
    const t = await ports.telegram();
    readsAll = t.readsAll ?? false;
    if (!t.member || !t.canSend || !t.polling) throw new Error();
    return 'Bot can access the group and send text/documents; no webhook conflicts with polling. No message sent.';
  });
  if (!readsAll) checks.push({ name: 'Telegram privacy mode', status: 'manual', detail: 'The bot sees only commands, mentions and replies to it, so photos, voice notes and forwards sent on their own never reach it. To change this, turn privacy off in BotFather (/setprivacy) or make the bot a group admin, then remove the bot from the group and add it again.' });
  await check('Fatture in Cloud company', async () => {
    if (!await ports.company()) throw new Error(); return 'Configured company is accessible.';
  });
  await check('Catalogue and shipping', async () => {
    const p = await ports.products(); if (!p.some(p => p.id === config.shipping.productId)) throw new Error();
    return `${p.length} catalogue entries read; configured shipping product found.`;
  });
  await check('Client access', async () => `${(await ports.clients()).length} client records accessible; no client data printed.`);
  await check('VAT mappings', async () => {
    const vats = await ports.vat();
    for (const rule of config.vatRules) {
      const vat = vats.find(v => v.id === rule.vatId);
      if (!vat || vat.is_disabled || vat.value !== rule.rate || (rule.nature && vat.ei_type?.replace(/^N/, '') !== rule.nature.replace(/^N/, ''))) throw new Error();
    }
    return 'All configured VAT IDs, rates and nature codes match enabled account entries.';
  });
  if (config.payments.methodId) await check('Payment method', async () => {
    if (!(await ports.payments()).some(p => p.id === config.payments.methodId)) throw new Error();
    return 'Configured payment method exists.';
  });
  else checks.push({ name: 'Payment defaults', status: 'manual', detail: 'No payment method configured; resolve the account default before enabling saves.' });
  checks.push({ name: 'Token scopes / API plan', status: 'manual', detail: 'Read access does not prove order-write rights, invoice exclusion, or write quota. Check token permissions and account plan manually; no write probes performed.' });
  checks.push({ name: 'LLM', status: 'manual', detail: 'No model request made. Use model:check for an explicit small billed probe; accuracy needs representative orders.' });
  return checks;
}
