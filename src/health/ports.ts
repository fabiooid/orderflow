import { CompaniesApi, Configuration, InfoApi } from '@fattureincloud/fattureincloud-ts-sdk';
import type { AppConfig } from '../config/schema.js';
import { FattureInCloudConnector } from '../connector/fatture-in-cloud.js';
import { TelegramApi } from '../telegram/api.js';
import type { HealthPorts } from './check.js';

export function liveHealthPorts(config: AppConfig, env: NodeJS.ProcessEnv): HealthPorts {
  const telegram = () => new TelegramApi(env.TELEGRAM_BOT_TOKEN ?? '');
  const sdk = () => {
    if (!env.FIC_ACCESS_TOKEN) throw new Error('FIC_ACCESS_TOKEN is missing');
    return new Configuration({ accessToken: env.FIC_ACCESS_TOKEN, baseOptions: { timeout: 15000 } });
  };
  const connector = () => FattureInCloudConnector.fromToken(config.companyId, env.FIC_ACCESS_TOKEN ?? '');
  return {
    telegram: async () => {
      const api = telegram(); const me = await api.getMe();
      const [chat, member, webhook] = await Promise.all([api.getChat(config.telegram.groupId), api.getChatMember(config.telegram.groupId, me.id), api.getWebhookInfo()]);
      const admin = ['administrator', 'creator'].includes(member.status);
      const memberOk = ['member', 'restricted'].includes(member.status);
      return {
        member: me.is_bot && String(chat.id) === config.telegram.groupId && ['group', 'supergroup'].includes(chat.type) && (admin || memberOk),
        canSend: admin || (memberOk && (member.status === 'restricted' ? member.can_send_messages === true && member.can_send_documents === true : chat.permissions?.can_send_messages === true && chat.permissions?.can_send_documents === true)),
        polling: !webhook.url,
        readsAll: admin || me.can_read_all_group_messages === true,
      };
    },
    company: async () => Boolean((await new CompaniesApi(sdk()).getCompanyInfo(config.companyId)).data.data),
    products: () => connector().listProducts(), clients: () => connector().listClients(),
    vat: async () => (await new InfoApi(sdk()).listVatTypes(config.companyId, 'detailed')).data.data ?? [],
    payments: async () => (await new InfoApi(sdk()).listPaymentMethods(config.companyId)).data.data ?? [],
  };
}
