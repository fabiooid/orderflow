import type { AppConfig } from '../config/schema.js';
import { copy } from './locales/index.js';
import type { OrderConnector } from '../connector/contract.js';
import { customerDetails } from '../domain/customer.js';
import { sameClient } from '../domain/matching.js';
import { PreflightFailed, type WriteJournal } from '../storage/write-journal.js';
import { journalKey, type Conversation } from './store.js';

/** No order or invoice capability is used by this operation. */
export function customerCreator(config: AppConfig, connector: Pick<OrderConnector, 'listClients' | 'createClient'>, journal: WriteJournal) {
  return async (conversation: Conversation) => {
    if (conversation.kind !== 'customer' || conversation.status !== 'ready') throw new Error('Customer confirmation requires a reviewed draft');
    const details = customerDetails(conversation.draft, config);
    if (!details.client) throw new Error('Customer details are incomplete');
    const client = details.client;
    const locale = { locale: conversation.locale ?? config.locale };
    const key = `${journalKey(config, conversation.orderId)}:customer`;
    const prior = await journal.replay<string>(key, client);
    if (prior) return prior.result;
    let matches;
    try { matches = (await connector.listClients()).filter(c => sameClient(c, client)); }
    catch { throw new PreflightFailed(); }
    const language = locale.locale;
    if (matches.length) return copy(language, 'customerDuplicate', { names: matches.map(c => `${c.name} (ID ${c.id})`).join(', ') });
    return journal.once(key, client, async () => {
      const saved = await connector.createClient(client);
      return copy(language, 'customerCreated', { name: saved.name, id: saved.id ?? '' });
    });
  };
}
