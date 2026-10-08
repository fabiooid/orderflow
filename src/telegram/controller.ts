import { createHash } from 'node:crypto';
import { traceOperation } from '../assistant/execution-trace.js';
import { translate, type AppConfig } from '../config/schema.js';
import { callbackData, mediaCallbackData, normalizeCallback, normalizeMessage, type MessageEvent, type OrderLink } from './adapter.js';
import { asksFirst, routeMessage, type Action, type IntentRouter } from './routing.js';
import { TelegramStore, type Conversation, type PlanEffects, type ReplyPlan } from './store.js';
import { MediaError, type MediaReader, type ReadMedia } from './media.js';
import type { Keyboard } from './api.js';
import { draftSchema, type SavedOrder } from '../domain/types.js';
import { PreflightFailed } from '../storage/write-journal.js';

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

type Reply = Pick<ReplyPlan, 'texts' | 'order' | 'pdfOrderId' | 'prompt'>;
type TargetedAction = Extract<Action, { target: OrderLink }>;
type Loaded = { linked?: Conversation; active?: Conversation };
const say = (text: string, order?: Conversation): Reply => ({ texts: [text], order });

/** Merges the other parts of a Telegram album into its first message. */
function withAlbum(event: MessageEvent, parts: MessageEvent[]): MessageEvent {
  if (!parts.length) return event;
  return { ...event, text: [event, ...parts].map(p => p.text).find(Boolean) ?? '', attachments: [event, ...parts].flatMap(p => p.attachments ?? []) };
}

export class TelegramController {
  private readonly policy: string;
  constructor(private readonly config: AppConfig, private readonly username: string, private readonly store: TelegramStore,
    private readonly engine: ConversationEngine,
    private readonly send: (text: string, replyTo: number, keyboard?: Keyboard) => Promise<{ message_id: number }>,
    private readonly createCustomer?: (previous: Conversation) => Promise<string>,
    private readonly saveOrder?: (previous: Conversation) => Promise<SavedOrder>,
    private readonly sendPdf?: (orderId: number) => Promise<{ message_id: number }>,
    private readonly buttons?: { answer: (id: string) => Promise<unknown>; clear: (messageId: number) => Promise<unknown> },
    private readonly media?: MediaReader) {
    this.policy = policyFingerprint(config);
  }

  private t(itText: string, en: string) { return translate(this.config, itText, en); }

  /**
   * Caller must serialize updates. Polling entry point uses an exclusive process lock.
   * `album` holds the other updates of the same Telegram album; they are answered together with this one.
   */
  async handle(update: { update_id: number }, album: { update_id: number }[] = []) {
    const id = update.update_id;
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid update identifier');
    let entry = await this.store.update(id);
    const callback = normalizeCallback(update, this.config);
    if (callback) await this.buttons?.answer(callback.id).catch(() => undefined);
    if (!entry) {
      let event: MessageEvent | null;
      let action: Action;
      let read: ReadMedia | undefined;
      const effects: PlanEffects = {};
      const loaded: Loaded = {};
      if (callback && callback.action.kind === 'pending') {
        const pending = await this.store.pending({ message: callback.action.message });
        if (!pending) { await this.buttons?.clear(callback.messageId).catch(() => undefined); await this.store.advance(id + 1); return; }
        event = callback.event;
        loaded.active = await this.store.activeRequest();
        if (!callback.action.accept) {
          effects.consume = pending.message;
          action = { kind: 'answer', text: this.t('Ok, lo ignoro.', 'OK, ignoring it.') };
        } else if (pending.value.target === undefined || (pending.value.target === null
          ? loaded.active !== undefined
          : loaded.active?.orderId !== pending.value.target.orderId || loaded.active.revision !== pending.value.target.revision)) {
          effects.consume = pending.message;
          action = { kind: 'answer', text: this.t('La richiesta è cambiata. Invia di nuovo l’allegato per scegliere a quale richiesta applicarlo.', 'The request has changed. Send the attachment again to choose which request it belongs to.') };
        } else {
          const result = pending.value.read ? { read: pending.value.read } : await this.read(pending.value.event);
          if ('read' in result) {
            read = result.read;
            event = { ...event, text: read.text };
            effects.consume = pending.message;
            const active = loaded.active;
            action = active ? { kind: 'edit', target: { orderId: active.orderId, revision: active.revision }, text: read.text } : { kind: 'start', customer: false, text: read.text };
          } else action = result.failed;
        }
      } else if (callback) {
        const target = callback.target!;
        const link = await this.store.link(callback.messageId);
        loaded.linked = await this.store.order(target.orderId);
        if (!link || link.orderId !== target.orderId || link.revision !== target.revision || loaded.linked?.revision !== target.revision) {
          await this.buttons?.clear(callback.messageId).catch(() => undefined);
          await this.store.advance(id + 1); return;
        }
        event = callback.event; action = callback.action;
      } else {
        event = normalizeMessage(update, this.config);
        if (!event) { await this.store.advance(id + 1); return; }
        const original = event;
        const parts = album.map(u => normalizeMessage(u, this.config)).filter((p): p is MessageEvent => p !== null && p.album === original.album);
        event = withAlbum(event, parts);
        effects.absorbed = parts.map(p => p.updateId);
        // A late album part joins its unanswered question instead of asking again.
        const joined = event.album && !parts.length ? await this.store.pending({ album: event.album }) : undefined;
        if (joined) {
          const value = { ...joined.value, read: undefined, event: withAlbum(joined.value.event, [event]) };
          await this.store.plan(id, { replyTo: event.messageId, texts: [] }, { pending: { message: joined.message, value } });
          await this.store.advance(id + 1); return;
        }
        const link = event.replyTo === undefined ? undefined : await this.store.link(event.replyTo);
        loaded.linked = link && await this.store.order(link.orderId);
        loaded.active = await this.store.activeRequest();
        const unread = event;
        if (asksFirst(event, { config: this.config, link, active: loaded.active })) action = { kind: 'prompt' };
        else {
          const result = event.attachments?.length || event.forwardedFrom ? await this.read(event) : undefined;
          if (result && 'failed' in result) action = result.failed;
          else {
            read = result?.read;
            if (read) event = { ...event, text: read.text };
            action = await routeMessage(event, { config: this.config, botUsername: this.username, link, ...loaded, model: this.engine.route });
          }
        }
        if (action.kind === 'prompt') effects.pending = { message: unread.messageId, value: { event: unread, target: loaded.active ? { orderId: loaded.active.orderId, revision: loaded.active.revision } : null, ...(read ? { read } : {}) } };
      }
      if (action.kind === 'ignore') {
        if (effects.absorbed?.length) await this.store.plan(id, { replyTo: event.messageId, texts: [] }, effects);
        await this.store.advance(id + 1); return;
      }
      const reply = await this.respond(action as Exclude<Action, { kind: 'ignore' | 'pending' }>, event, id, loaded);
      if (read?.echo && reply.texts.length) {
        const first = `${read.echo}\n\n${reply.texts[0]}`;
        reply.texts = first.length <= 4000 ? [first, ...reply.texts.slice(1)] : [...chunks(read.echo), ...reply.texts];
      }
      await this.store.plan(id, { replyTo: event.messageId, ...reply, incomingText: event.text, senderId: event.senderId, receivedAt: new Date().toISOString() }, effects);
      entry = (await this.store.update(id))!;
    }
    if (entry.sending) throw new Error(`Telegram delivery uncertain for update ${id}. Use telegram:recover after inspecting the group.`);
    while (!entry.done) {
      await this.store.beginSend(id);
      const text = entry.plan.texts[entry.next];
      const sent = text
        ? await this.send(text, entry.plan.replyTo, entry.next === entry.plan.texts.length - 1 ? this.keyboard(entry.plan) : undefined)
        : this.sendPdf && entry.plan.pdfOrderId !== undefined
          ? await this.sendPdf(entry.plan.pdfOrderId)
          : undefined;
      if (!sent) throw new Error('PDF delivery is not available for this update');
      await this.store.sent(id, sent.message_id);
      entry = (await this.store.update(id))!;
    }
    if (entry.plan.texts.length) await this.engine.record?.(id, entry.plan);
    if (callback) await this.buttons?.clear(callback.messageId).catch(() => undefined);
    await this.store.advance(id + 1);
  }

  /** Media and forwards as text. Failures become a reply; the media stays unanswered so it can be sent again. */
  private async read(event: MessageEvent): Promise<{ read: ReadMedia } | { failed: Action }> {
    const fail = (text: string) => ({ failed: { kind: 'answer' as const, text } });
    if (!this.media) return fail(this.t('Allegati e note vocali non sono attivi in questa installazione.', 'Attachments and voice notes are not enabled in this deployment.'));
    try { return { read: await this.media(event) }; }
    catch (error) {
      return fail(error instanceof MediaError ? error.message : this.t('Non sono riuscito a leggere l’allegato. Nessun dato salvato: invialo di nuovo o scrivi i dettagli.', 'I could not read the attachment. Nothing was saved: send it again or type the details.'));
    }
  }

  private async respond(action: Exclude<Action, { kind: 'ignore' | 'pending' }>, event: MessageEvent, id: number, { linked, active }: Loaded): Promise<Reply> {
    const load = async (orderId: string) => orderId === linked?.orderId ? linked : orderId === active?.orderId ? active : this.store.order(orderId);
    switch (action.kind) {
      case 'answer': return { texts: chunks(action.text) };
      case 'prompt': return {
        texts: [active ? this.t('Aggiungo questo alla richiesta aperta?', 'Add this to the open request?') : this.t('Preparo un ordine da questo?', 'Prepare an order from this?')],
        prompt: { message: event.messageId, active: Boolean(active) },
      };
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

  private async start(action: Extract<Action, { kind: 'start' }>, event: MessageEvent, id: number, active?: Conversation): Promise<Reply> {
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
        const saved = await traceOperation('Confirmed order save', () => this.saveOrder!(previous), { orderId: previous.orderId, revision: previous.revision, policy: previous.policy });
        return { texts: [this.t(`Ordine ${saved.number} salvato in Fatture in Cloud. Il PDF segue in questo gruppo; nessun invio al cliente.`, `Order ${saved.number} saved in Fatture in Cloud. The PDF follows in this group; nothing was sent to the customer.`)], pdfOrderId: saved.id, order: { ...previous, status: 'saved', savedOrder: saved, revision: previous.revision + 1 } };
      } catch (error) {
        if (error instanceof PreflightFailed) return say(error.needsReview
          ? this.t('I dati sono cambiati. Nessun salvataggio tentato: rispondi per aggiornare il riepilogo prima di confermare.', 'Details changed. No save was attempted: reply to refresh the summary before confirming.')
          : this.t('Controlli temporaneamente non disponibili. Nessun salvataggio tentato: puoi riprovare a confermare.', 'Checks are temporarily unavailable. No save was attempted: you can confirm again.'),
          error.needsReview ? { ...previous, revision: previous.revision + 1, status: 'new', prepared: undefined, totals: undefined } : previous);
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
    if (previous.status === 'saving') return say(this.t('Creazione cliente da verificare in Fatture in Cloud. Modifiche e nuovi tentativi bloccati fino alla riconciliazione.', 'Customer creation needs checking in Fatture in Cloud. Edits and retries are blocked until reconciliation.'), previous);
    if (previous.status === 'reviewed') return say(this.t('Richiesta cliente conclusa. Usa /cliente per una nuova richiesta.', 'Customer request completed. Use /customer for a new one.'), previous);
    if (action.kind === 'edit') return this.process(action.text, previous);
    if (action.kind !== 'confirmCustomer') return say(this.t('Per i clienti usa /confermacliente sul riepilogo più recente.', 'For customers, use /confirmcustomer on the latest summary.'), previous);
    if (previous.status !== 'ready' || !this.createCustomer) return say(this.t('Creazione non disponibile: completa i dati e controlla il riepilogo.', 'Creation unavailable: complete the details and check the summary.'), previous);
    try {
      return say(await traceOperation('Confirmed customer save', () => this.createCustomer!(previous), { orderId: previous.orderId, revision: previous.revision, policy: previous.policy }), { ...previous, status: 'reviewed', revision: previous.revision + 1 });
    } catch (error) {
      if (error instanceof PreflightFailed) return say(this.t('Controlli temporaneamente non disponibili. Nessun salvataggio tentato: puoi riprovare a confermare.', 'Checks are temporarily unavailable. No save was attempted: you can confirm again.'), previous);
      return say(this.t('Creazione cliente non confermata. Non ripetere la richiesta: controlla Fatture in Cloud prima di riprovare. Nessun ordine o fattura creato.', 'Customer creation was not confirmed. Do not repeat the request: reconcile Fatture in Cloud before retrying. No order or invoice created.'), { ...previous, status: 'saving' });
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

  private keyboard({ order, prompt }: ReplyPlan): Keyboard | undefined {
    if (prompt) return { inline_keyboard: [[
      { text: this.t('✅ Sì', '✅ Yes'), callback_data: mediaCallbackData(prompt.message, true) },
      { text: this.t('✖️ No', '✖️ No'), callback_data: mediaCallbackData(prompt.message, false) },
    ]] };
    if (!order || !['new', 'suspended', 'ready'].includes(order.status)) return undefined;
    const link = { orderId: order.orderId, revision: order.revision };
    const row = [];
    if (order.status === 'ready' && (order.kind === 'customer' ? this.createCustomer : this.saveOrder && this.sendPdf)) row.push({ text: this.t('✅ Conferma e salva', '✅ Confirm and save'), callback_data: callbackData(order.kind === 'customer' ? 'customer' : 'save', link) });
    row.push({ text: this.t('❌ Annulla', '❌ Cancel'), callback_data: callbackData('cancel', link) });
    return { inline_keyboard: [row] };
  }
}
