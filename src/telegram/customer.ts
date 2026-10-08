import type { AppConfig } from '../config/schema.js';
import type { OrderConnector } from '../connector/contract.js';
import { clientSchema, type OrderDraft } from '../domain/types.js';
import { sameClient } from '../domain/matching.js';
import { PreflightFailed, type WriteJournal } from '../storage/write-journal.js';
import { journalKey, type Conversation } from './store.js';

export function customerDetails(draft: OrderDraft, config: AppConfig) {
  const parsed = clientSchema.safeParse(draft.newClient);
  if (!parsed.success) return { error: 'Completa nome, indirizzo, città, CAP e paese; verifica il formato di email e codice SDI.' } as const;
  const client = parsed.data;
  const missing = config.clients.requiredFields.filter(field => !client[field]);
  if (config.clients.sdiCountries.includes(client.country) && !client.sdiCode) return { error: 'Manca il codice SDI.' } as const;
  if (missing.length) return { error: `Dati mancanti: ${missing.join(', ')}. Non inventare identificativi fiscali.` } as const;
  return { client } as const;
}

/** No order or invoice capability is used by this operation. */
export function customerCreator(config: AppConfig, connector: Pick<OrderConnector, 'listClients' | 'createClient'>, journal: WriteJournal) {
  return async (conversation: Conversation) => {
    if (conversation.kind !== 'customer' || conversation.status !== 'ready') throw new Error('Customer confirmation requires a reviewed draft');
    const details = customerDetails(conversation.draft, config);
    if (!details.client) throw new Error('Customer details are incomplete');
    const client = details.client;
    const key = `${journalKey(config, conversation.orderId)}:customer`;
    const prior = await journal.replay<string>(key, client);
    if (prior) return prior.result;
    let matches;
    try { matches = (await connector.listClients()).filter(c => sameClient(c, client)); }
    catch { throw new PreflightFailed(); }
    if (matches.length) return `Cliente già presente: ${matches.map(c => `${c.name} (ID ${c.id})`).join(', ')}. Nessun duplicato creato.`;
    return journal.once(key, client, async () => {
      const saved = await connector.createClient(client);
      return `Cliente creato: ${saved.name} (ID ${saved.id}). Nessun ordine o fattura creato; nessuna email inviata.`;
    });
  };
}
