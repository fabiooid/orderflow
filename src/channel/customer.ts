import { translate, type AppConfig } from '../config/schema.js';
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
    if (matches.length) return translate(locale, `Cliente già presente: ${matches.map(c => `${c.name} (ID ${c.id})`).join(', ')}. Nessun duplicato creato.`, `Customer already exists: ${matches.map(c => `${c.name} (ID ${c.id})`).join(', ')}. No duplicate created.`);
    return journal.once(key, client, async () => {
      const saved = await connector.createClient(client);
      return translate(locale, `Cliente creato: ${saved.name} (ID ${saved.id}). Nessun ordine o fattura creato; nessuna email inviata.`, `Customer created: ${saved.name} (ID ${saved.id}). No order or invoice created; no email sent.`);
    });
  };
}
