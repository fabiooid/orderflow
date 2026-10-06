import { createHash } from 'node:crypto';
import type { AppConfig } from '../config/schema.js';
import { callbackData, normalizeCallback, normalizeTextUpdate, type OrderLink, type TextEvent } from './adapter.js';
import { routeMessage, type Action, type IntentRouter } from './routing.js';
import { TelegramStore, type Conversation, type ReplyPlan } from './store.js';
import type { Keyboard } from './api.js';
import { draftSchema, type SavedOrder } from '../domain/types.js';

export type { Intent } from './routing.js';
export type ConversationEngine = ((text: string, previous: Conversation) => Promise<{ conversation: Conversation; text: string }>) & {
  route?: IntentRouter;
  record?: (id: number, plan: ReplyPlan) => Promise<void>;
};
export function policyFingerprint(config: AppConfig) { return createHash('sha256').update(JSON.stringify(config)).digest('hex'); }
function chunks(text: string): string[] {
  const result: string[] = [];
  while (text.length > 3500) { result.push(text.slice(0, 3500)); text = text.slice(3500); }
  if (text) result.push(text);
  return result;
}

type Reply = Pick<ReplyPlan, 'texts' | 'order' | 'pdfOrderId'>;
type TargetedAction = Extract<Action, { target: OrderLink }>;
type Loaded = { linked?: Conversation; active?: Conversation };
const say = (text: string, order?: Conversation): Reply => ({ texts: [text], order });

export class TelegramController {
  private readonly policy: string;
  constructor(private readonly config: AppConfig, private readonly username: string, private readonly store: TelegramStore,
    private readonly engine: ConversationEngine,
    private readonly send: (text: string, replyTo: number, keyboard?: Keyboard) => Promise<{ message_id: number }>,
    private readonly createCustomer?: (previous: Conversation) => Promise<string>,
    private readonly saveOrder?: (previous: Conversation) => Promise<SavedOrder>,
    private readonly sendPdf?: (orderId: number) => Promise<{ message_id: number }>,
    private readonly buttons?: { answer: (id: string) => Promise<unknown>; clear: (messageId: number) => Promise<unknown> }) {
    this.policy = policyFingerprint(config);
  }

  private t(itText: string, en: string) { return this.config.locale === 'it' ? itText : en; }

  /** Caller must serialize updates. Polling entry point uses an exclusive process lock. */
  async handle(update: { update_id: number }) {
    const id = update.update_id;
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid update identifier');
    let entry = await this.store.update(id);
    const callback = normalizeCallback(update, this.config);
    if (callback) await this.buttons?.answer(callback.id).catch(() => undefined);
    if (!entry) {
      let event: TextEvent | null;
      let action: Action;
      const loaded: Loaded = {};
      if (callback) {
        const link = await this.store.link(callback.messageId);
        loaded.linked = await this.store.order(callback.target.orderId);
        if (!link || link.orderId !== callback.target.orderId || link.revision !== callback.target.revision || loaded.linked?.revision !== callback.target.revision) {
          await this.buttons?.clear(callback.messageId).catch(() => undefined);
          await this.store.advance(id + 1); return;
        }
        event = callback.event; action = callback.action;
      } else {
        event = normalizeTextUpdate(update, this.config);
        if (!event) { await this.store.advance(id + 1); return; }
        const link = event.replyTo === undefined ? undefined : await this.store.link(event.replyTo);
        loaded.linked = link && await this.store.order(link.orderId);
        loaded.active = await this.store.activeRequest();
        action = await routeMessage(event, { config: this.config, botUsername: this.username, link, ...loaded, model: this.engine.route });
      }
      if (action.kind === 'ignore') { await this.store.advance(id + 1); return; }
      const reply = await this.respond(action, event, id, loaded);
      await this.store.plan(id, { replyTo: event.messageId, ...reply, incomingText: event.text, senderId: event.senderId, receivedAt: new Date().toISOString() });
      entry = (await this.store.update(id))!;
    }
    if (entry.sending) throw new Error(`Telegram delivery uncertain for update ${id}. Use telegram:recover after inspecting the group.`);
    while (!entry.done) {
      await this.store.beginSend(id);
      const text = entry.plan.texts[entry.next];
      const sent = text
        ? await this.send(text, entry.plan.replyTo, entry.next === entry.plan.texts.length - 1 ? this.keyboard(entry.plan.order) : undefined)
        : this.sendPdf && entry.plan.pdfOrderId !== undefined
          ? await this.sendPdf(entry.plan.pdfOrderId)
          : undefined;
      if (!sent) throw new Error('PDF delivery is not available for this update');
      await this.store.sent(id, sent.message_id);
      entry = (await this.store.update(id))!;
    }
    await this.engine.record?.(id, entry.plan);
    if (callback) await this.buttons?.clear(callback.messageId).catch(() => undefined);
    await this.store.advance(id + 1);
  }

  private async respond(action: Exclude<Action, { kind: 'ignore' }>, event: TextEvent, id: number, { linked, active }: Loaded): Promise<Reply> {
    const load = async (orderId: string) => orderId === linked?.orderId ? linked : orderId === active?.orderId ? active : this.store.order(orderId);
    switch (action.kind) {
      case 'answer': return { texts: chunks(action.text) };
      case 'start': return this.start(action, event, id, active);
      case 'cancel': return this.cancel(action.target ? await load(action.target.orderId) : active);
      default: {
        const previous = await load(action.target.orderId);
        if (!previous || action.target.revision !== previous.revision) return say(this.t('Questo messaggio riguarda una versione precedente. Rispondi al riepilogo più recente.', 'This message refers to an older revision. Reply to the latest summary.'));
        if (previous.status === 'cancelled') return say(this.t('Richiesta annullata. Usa /ordine o /cliente per iniziarne una nuova.', 'This request was cancelled. Use /order or /customer to start a new one.'), previous);
        if (previous.policy !== this.policy) return say(this.t('La configurazione è cambiata. Inizia un nuovo ordine per ricalcolare i dati.', 'Configuration changed. Start a new order to recalculate its data.'));
        return previous.kind === 'customer' ? this.customerAction(action, previous) : this.orderAction(action, previous);
      }
    }
  }

  private async start(action: Extract<Action, { kind: 'start' }>, event: TextEvent, id: number, active?: Conversation): Promise<Reply> {
    if (active) return say(this.t('C’è già una richiesta aperta. Completala oppure annullala prima di iniziarne un’altra.', 'A request is already open. Complete or cancel it before starting another.'));
    const fresh: Conversation = { orderId: `u${id}`, startedBy: event.senderId, startedAt: new Date().toISOString(), revision: 0, status: 'new', ...(action.customer ? { kind: 'customer' as const } : {}), draft: draftSchema.parse({}), questions: '', policy: this.policy };
    if (action.text) return this.process(action.text, fresh);
    return say(action.customer
      ? this.t('Descrivi il nuovo cliente: nome, indirizzo, paese, email, telefono e partita IVA. Nessun dato verrà salvato senza /confermacliente. /annulla per annullare.', 'Describe the new customer: name, address, country, email, phone and VAT number. Nothing is saved without /confirmcustomer. /cancel to cancel.')
      : this.t('Descrivi cliente, prodotti, quantità e costo di consegna. /annulla per annullare.', 'Describe the client, products, quantities and delivery charge. /cancel to cancel.'), fresh);
  }

  private cancel(previous?: Conversation): Reply {
    if (!previous || previous.status === 'cancelled') return say(this.t('Nessuna richiesta aperta da annullare.', 'No open request to cancel.'));
    if (previous.status === 'saving') return say(this.t('Salvataggio da verificare in Fatture in Cloud: non si può annullare qui.', 'Save needs checking in Fatture in Cloud; it cannot be cancelled here.'), previous);
    if (previous.status === 'saved' || (previous.kind === 'customer' && previous.status === 'reviewed')) return say(this.t('Già salvato in Fatture in Cloud: non si può annullare qui.', 'Already saved in Fatture in Cloud; it cannot be cancelled here.'), previous);
    return say(this.t('Annullato. Nulla è stato salvato. Usa /ordine o /cliente per ricominciare.', 'Cancelled. Nothing was saved. Use /order or /customer to start again.'), { ...previous, status: 'cancelled' });
  }

  private async orderAction(action: TargetedAction, previous: Conversation): Promise<Reply> {
    if (action.kind === 'confirmOrder') {
      if (previous.status === 'saved') return say(this.t(`Ordine già salvato: ${previous.savedOrder?.number}. Nessun duplicato creato.`, `Order already saved: ${previous.savedOrder?.number}. No duplicate created.`), previous);
      if (!this.saveOrder || !this.sendPdf || !['ready', 'saving'].includes(previous.status) || !previous.prepared) return say(this.t('Completa i dati e conferma il riepilogo più recente.', 'Complete the details and confirm the latest summary.'), previous);
      try {
        const saved = await this.saveOrder(previous);
        return { texts: [this.t(`Ordine ${saved.number} salvato in Fatture in Cloud. Il PDF segue in questo gruppo; nessun invio al cliente.`, `Order ${saved.number} saved in Fatture in Cloud. The PDF follows in this group; nothing was sent to the customer.`)], pdfOrderId: saved.id, order: { ...previous, status: 'saved', savedOrder: saved, revision: previous.revision + 1 } };
      } catch {
        return say(this.t('Salvataggio non confermato. Non creare una nuova richiesta: occorre verificare Fatture in Cloud prima di riprovare per evitare duplicati.', 'Save not confirmed. Do not start a new request: check Fatture in Cloud before retrying to avoid duplicates.'), { ...previous, status: 'saving' });
      }
    }
    if (previous.status === 'saved') return say(this.t('Ordine già salvato. Le modifiche successive al salvataggio richiedono gestione manuale in Fatture in Cloud.', 'Order already saved. Changes after saving must be made manually in Fatture in Cloud.'), previous);
    if (previous.status === 'saving') return say(this.t('Salvataggio da verificare: modifiche bloccate per evitare duplicati.', 'Save needs checking: changes are blocked to avoid duplicates.'), previous);
    if (previous.status === 'reviewed' && action.kind !== 'reopen') return say(this.t('Ordine revisionato. Rispondi /reopen a questo riepilogo per modificarlo.', 'Order reviewed. Reply /reopen to its summary to edit it.'), previous);
    switch (action.kind) {
      case 'review': return previous.status === 'ready'
        ? say(this.t('Revisione registrata. Nessun ordine salvato o inviato al cliente (modalità anteprima).', 'Review recorded. No order saved or sent to the customer (preview mode).'), { ...previous, status: 'reviewed' })
        : say(this.t('Completa prima i dati mancanti.', 'Resolve missing details first.'), previous);
      case 'reopen': return say(this.t('Rispondi con le modifiche.', 'Reply with your changes.'), { ...previous, status: 'ready' });
      case 'edit': return this.process(action.text, previous);
      default: return say(this.t('Questo comando vale solo per i clienti.', 'This command applies to customers only.'), previous);
    }
  }

  private async customerAction(action: TargetedAction, previous: Conversation): Promise<Reply> {
    if (previous.status === 'reviewed') return say(this.t('Richiesta cliente conclusa. Usa /cliente per una nuova richiesta.', 'Customer request completed. Use /customer for a new one.'), previous);
    if (action.kind === 'edit') return this.process(action.text, previous);
    if (action.kind !== 'confirmCustomer') return say(this.t('Per i clienti usa /confermacliente sul riepilogo più recente.', 'For customers, use /confirmcustomer on the latest summary.'), previous);
    if (previous.status !== 'ready' || !this.createCustomer) return say(this.t('Creazione non disponibile: completa i dati e controlla il riepilogo.', 'Creation unavailable: complete the details and check the summary.'), previous);
    try {
      return say(await this.createCustomer(previous), { ...previous, status: 'reviewed', revision: previous.revision + 1 });
    } catch {
      return say(this.t('Creazione cliente non confermata. Non ripetere la richiesta: occorre verificare i permessi Clienti e controllare Fatture in Cloud prima di riprovare. Nessun ordine o fattura creato.', 'Customer creation was not confirmed. Do not repeat the request: check Clients permissions and reconcile Fatture in Cloud before retrying. No order or invoice created.'), previous);
    }
  }

  private async process(text: string, previous: Conversation): Promise<Reply> {
    try {
      const result = await this.engine(text, previous);
      return { texts: chunks(result.text), order: result.conversation };
    } catch {
      return say(this.t('Non sono riuscito a interpretare il messaggio. Nessun dato salvato. Rispondi a questo messaggio ripetendo i dettagli.', 'I could not interpret the message. Nothing was saved. Reply to this message with the details again.'), previous);
    }
  }

  private keyboard(order?: Conversation): Keyboard | undefined {
    if (!order || !['new', 'suspended', 'ready'].includes(order.status)) return undefined;
    const link = { orderId: order.orderId, revision: order.revision };
    const row = [];
    if (order.status === 'ready' && (order.kind === 'customer' ? this.createCustomer : this.saveOrder && this.sendPdf)) row.push({ text: this.t('✅ Conferma e salva', '✅ Confirm and save'), callback_data: callbackData(order.kind === 'customer' ? 'customer' : 'save', link) });
    row.push({ text: this.t('❌ Annulla', '❌ Cancel'), callback_data: callbackData('cancel', link) });
    return { inline_keyboard: [row] };
  }
}
