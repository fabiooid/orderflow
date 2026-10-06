import { createHash } from 'node:crypto';
import type { AppConfig } from '../config/schema.js';
import { normalizeCallback, normalizeTextUpdate, parseCommand, routeTextEvent } from './adapter.js';
import { TelegramStore, type Conversation, type ReplyPlan } from './store.js';
import type { Keyboard } from './api.js';
import { draftSchema, type SavedOrder } from '../domain/types.js';

export type Intent = { action: 'continue' | 'order' | 'customer' | 'cancel' | 'answer'; text: string };
export type ConversationEngine = ((text: string, previous: Conversation) => Promise<{ conversation: Conversation; text: string }>) & {
  route?: (text: string, senderId: string, active?: Conversation) => Promise<Intent>;
  record?: (id: number, plan: ReplyPlan) => Promise<void>;
};
export function policyFingerprint(config: AppConfig) { return createHash('sha256').update(JSON.stringify(config)).digest('hex'); }
function chunks(text: string): string[] {
  const result: string[] = [];
  while (text.length > 3500) { result.push(text.slice(0, 3500)); text = text.slice(3500); }
  if (text) result.push(text);
  return result;
}

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

  /** Caller must serialize updates. Polling entry point uses an exclusive process lock. */
  async handle(update: { update_id: number }) {
    const id = update.update_id;
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid update identifier');
    let entry = await this.store.update(id);
    const callback = normalizeCallback(update, this.config);
    if (callback) {
      await this.buttons?.answer(callback.id).catch(() => undefined);
      const link = await this.store.link(callback.messageId);
      const state = await this.store.order(callback.orderId);
      if (!entry && (!link || link.orderId !== callback.orderId || link.revision !== callback.revision || state?.revision !== callback.revision)) {
        await this.buttons?.clear(callback.messageId).catch(() => undefined);
        await this.store.advance(id + 1); return;
      }
      update = callback.update;
    }
    if (!entry) {
      const event = normalizeTextUpdate(update, this.config);
      if (!event) { await this.store.advance(id + 1); return; }
      const link = event.replyTo === undefined ? undefined : await this.store.link(event.replyTo);
      const links = new Map(event.replyTo !== undefined && link ? [[event.replyTo, link]] : []);
      const linked = link && await this.store.order(link.orderId);
      const active = await this.store.activeRequest();
      const open = active ? {orderId:active.orderId,revision:active.revision} : undefined;
      let route = routeTextEvent(event, this.config, this.username, links, open);
      let answer: string | undefined;
      let contextualText: string | undefined;
      const isCommand = event.text.trim().startsWith('/');
      // A linked older summary must never be reinterpreted against a newer draft.
      if (!isCommand && this.engine.route && (!link || linked?.revision === link.revision)) {
        const selected = link ? linked : active;
        const intent = await this.engine.route(event.text, event.senderId, selected).catch(() => ({action:'answer' as const,text:this.config.locale === 'it' ? 'Non riesco a elaborare il messaggio. Riprova; la richiesta aperta non è stata modificata.' : 'Unable to process this message. Please retry; the open request is unchanged.'}));
        contextualText = intent.text;
        if (intent.action === 'answer') answer = intent.text;
        else if (intent.action === 'cancel') route = {kind:'cancel',orderId:selected?.orderId};
        else if (intent.action === 'order' || intent.action === 'customer') {
          if (active) answer = this.config.locale === 'it' ? 'C’è già una richiesta aperta. Completiamola oppure annullala prima di iniziarne un’altra.' : 'A request is already open. Complete or cancel it before starting another.';
          else route = intent.action === 'customer' ? {kind:'new',customer:true,text:event.text} : {kind:'new',text:event.text};
        } else if (selected) route = {kind:'reply',orderId:selected.orderId,revision:selected.revision,text:event.text};
        else answer = this.config.locale === 'it' ? 'Quale ordine o cliente vuoi preparare?' : 'Which order or customer would you like to prepare?';
      }
      if (route.kind === 'new' && active && isCommand) answer = this.config.locale === 'it' ? 'C’è già una richiesta aperta. Completa o annulla quella prima di iniziarne un’altra.' : 'Complete or cancel the open request first.';
      if (route.kind === 'unrouted' && answer === undefined) { await this.store.advance(id + 1); return; }
      const command = parseCommand(event.text.trim(), this.username);
      const confirms = (...names: string[]) => Boolean(command && !command.text && names.includes(command.name));
      const it = this.config.locale === 'it';
      const load = (orderId: string) => orderId === linked?.orderId ? linked : orderId === active?.orderId ? active : this.store.order(orderId);
      let previous = route.kind === 'reply' ? await load(route.orderId)
        : route.kind === 'cancel' ? (route.orderId ? await load(route.orderId) : active)
        : undefined;
      let plan: ReplyPlan;
      if (answer !== undefined) plan = {replyTo:event.messageId,texts:chunks(answer)};
      else if (route.kind === 'cancel') {
        if (!previous || previous.kind === 'catalogue' || previous.status === 'cancelled') plan = { replyTo: event.messageId, texts: [it ? 'Nessuna richiesta aperta da annullare.' : 'No open request to cancel.'] };
        else if (previous.status === 'saving') plan = { replyTo: event.messageId, texts: [it ? 'Salvataggio da verificare in Fatture in Cloud: non si può annullare qui.' : 'Save needs checking in Fatture in Cloud; it cannot be cancelled here.'], order: previous };
        else if (previous.status === 'saved' || (previous.kind === 'customer' && previous.status === 'reviewed')) plan = { replyTo: event.messageId, texts: [it ? 'Già salvato in Fatture in Cloud: non si può annullare qui.' : 'Already saved in Fatture in Cloud; it cannot be cancelled here.'], order: previous };
        else plan = { replyTo: event.messageId, texts: [it ? 'Annullato. Nulla è stato salvato. Usa /ordine o /cliente per ricominciare.' : 'Cancelled. Nothing was saved. Use /order or /customer to start again.'], order: { ...previous, status: 'cancelled' } };
      } else if (route.kind === 'reply' && (!previous || route.revision !== previous.revision)) {
        plan = { replyTo: event.messageId, texts: [it ? 'Questo messaggio riguarda una versione precedente. Rispondi al riepilogo più recente.' : 'This message refers to an older revision. Reply to the latest summary.'] };
      } else if (previous?.status === 'cancelled') {
        plan = { replyTo: event.messageId, texts: [it ? 'Richiesta annullata. Usa /ordine o /cliente per iniziarne una nuova.' : 'This request was cancelled. Use /order or /customer to start a new one.'], order: previous };
      } else if (previous && previous.policy !== this.policy) {
        plan = { replyTo: event.messageId, texts: [it ? 'La configurazione è cambiata. Inizia un nuovo ordine per ricalcolare i dati.' : 'Configuration changed. Start a new order to recalculate its data.'] };
      } else if (previous && !previous.kind && confirms('confermaordine', 'confirmorder')) {
        if (previous.status === 'saved') plan = {replyTo:event.messageId,texts:[`Ordine già salvato: ${previous.savedOrder?.number}. Nessun duplicato creato.`],order:previous};
        else if (!this.saveOrder || !this.sendPdf || !['ready','saving'].includes(previous.status) || !previous.prepared) plan = {replyTo:event.messageId,texts:['Completa i dati e conferma il riepilogo più recente.'],order:previous};
        else {
          try {
            const saved = await this.saveOrder(previous);
            plan = {replyTo:event.messageId,texts:[`Ordine ${saved.number} salvato in Fatture in Cloud. Il PDF segue in questo gruppo; nessun invio al cliente.`],pdfOrderId:saved.id,order:{...previous,status:'saved',savedOrder:saved,revision:previous.revision+1}};
          } catch {
            plan = {replyTo:event.messageId,texts:['Salvataggio non confermato. Non creare una nuova richiesta: occorre verificare Fatture in Cloud prima di riprovare per evitare duplicati.'],order:{...previous,status:'saving'}};
          }
        }
      } else if (previous && ['saving','saved'].includes(previous.status)) {
        plan = {replyTo:event.messageId,texts:[previous.status === 'saved' ? 'Ordine già salvato. Le modifiche successive al salvataggio richiedono gestione manuale in Fatture in Cloud.' : 'Salvataggio da verificare: modifiche bloccate per evitare duplicati.'],order:previous};
      } else if (previous?.kind === 'customer' && confirms('confirmcustomer', 'confermacliente')) {
        if (previous.status !== 'ready' || !this.createCustomer) plan = { replyTo: event.messageId, texts: ['Creazione non disponibile: completa i dati e controlla il riepilogo.'], order: previous };
        else {
          try {
            const result = await this.createCustomer(previous);
            plan = { replyTo: event.messageId, texts: [result], order: { ...previous, status: 'reviewed', revision: previous.revision + 1 } };
          } catch {
            plan = { replyTo: event.messageId, texts: [it ? 'Creazione cliente non confermata. Non ripetere la richiesta: occorre verificare i permessi Clienti e controllare Fatture in Cloud prima di riprovare. Nessun ordine o fattura creato.' : 'Customer creation was not confirmed. Do not repeat the request: check Clients permissions and reconcile Fatture in Cloud before retrying. No order or invoice created.'], order: previous };
          }
        }
      } else if (previous?.kind === 'customer' && previous.status === 'reviewed') {
        plan = { replyTo: event.messageId, texts: ['Richiesta cliente conclusa. Usa /cliente per una nuova richiesta.'], order: previous };
      } else if (previous?.status === 'reviewed' && event.text.trim() !== '/reopen') {
        plan = { replyTo: event.messageId, texts: [it ? 'Ordine revisionato. Rispondi /reopen a questo riepilogo per modificarlo.' : 'Order reviewed. Reply /reopen to its summary to edit it.'], order: previous };
      } else if (previous && event.text.trim() === '/review') {
        if (previous.status !== 'ready') plan = { replyTo: event.messageId, texts: [it ? 'Completa prima i dati mancanti.' : 'Resolve missing details first.'], order: previous };
        else plan = { replyTo: event.messageId, texts: [it ? 'Revisione registrata. Nessun ordine salvato o inviato al cliente (modalità anteprima).' : 'Review recorded. No order saved or sent to the customer (preview mode).'], order: { ...previous, status: 'reviewed' } };
      } else if (previous && event.text.trim() === '/reopen') {
        plan = { replyTo: event.messageId, texts: [it ? 'Rispondi con le modifiche.' : 'Reply with your changes.'], order: { ...previous, status: 'ready' } };
      } else {
        previous ??= { orderId: `u${id}`, startedBy: event.senderId, startedAt: new Date().toISOString(), revision: 0, status: 'new', ...(route.kind === 'new' && 'customer' in route ? { kind: 'customer' as const } : route.kind === 'new' && 'catalogue' in route ? { kind: 'catalogue' as const } : {}), draft: draftSchema.parse({}), questions: '', policy: this.policy };
        const text = contextualText ?? (route.kind === 'new' ? route.text : event.text);
        if (!text) plan = { replyTo: event.messageId, texts: [previous.kind === 'catalogue' ? 'Chiedimi quali prodotti, formati o varianti sono in catalogo.' : previous.kind === 'customer' ? 'Descrivi il nuovo cliente: nome, indirizzo, paese, email, telefono e partita IVA. Nessun dato verrà salvato senza /confermacliente. /annulla per annullare.' : it ? 'Descrivi cliente, prodotti, quantità e costo di consegna. /annulla per annullare.' : 'Describe the client, products, quantities and delivery charge. /cancel to cancel.'], order: previous };
        else {
          try {
            const result = await this.engine(text, previous);
            plan = { replyTo: event.messageId, texts: chunks(result.text), order: result.conversation };
          } catch {
            plan = { replyTo: event.messageId, texts: [it ? 'Non sono riuscito a interpretare il messaggio. Nessun dato salvato. Rispondi a questo messaggio ripetendo i dettagli.' : 'I could not interpret the message. Nothing was saved. Reply to this message with the details again.'], order: previous };
          }
        }
      }
      plan.incomingText = event.text;
      plan.senderId = event.senderId;
      plan.receivedAt = new Date().toISOString();
      await this.store.plan(id, plan);
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
  private keyboard(order?: Conversation): Keyboard | undefined {
    if (!order || order.kind === 'catalogue' || !['new','suspended','ready'].includes(order.status)) return undefined;
    const it = this.config.locale === 'it';
    const row = [];
    if (order.status === 'ready' && (order.kind === 'customer' ? this.createCustomer : this.saveOrder && this.sendPdf)) row.push({text:it ? '✅ Conferma e salva' : '✅ Confirm and save',callback_data:`${order.kind === 'customer' ? 'customer' : 'save'}:${order.orderId}:${order.revision}`});
    row.push({text:it ? '❌ Annulla' : '❌ Cancel',callback_data:`cancel:${order.orderId}:${order.revision}`});
    return {inline_keyboard:[row]};
  }
}
