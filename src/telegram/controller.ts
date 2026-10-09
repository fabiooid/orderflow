import { createHash } from 'node:crypto';
import { traceOperation } from '../assistant/execution-trace.js';
import { translate, type AppConfig } from '../config/schema.js';
import { callbackData, mediaCallbackData, normalizeCallback, normalizeMessage, pickData, type MessageEvent } from './adapter.js';
import { asksFirst, routeMessage, type Action } from './routing.js';
import { kindOf, TelegramStore, type Conversation, type PlanEffects, type ReplyPlan } from './store.js';
import { MediaError, type MediaReader, type ReadMedia } from './media.js';
import type { Keyboard } from './api.js';
import { draftSchema, type SavedOrder } from '../domain/types.js';
import { MAX_CHOICES } from '../domain/matching.js';
import { lineIndex, pickable } from './preview.js';
import { PreflightFailed } from '../storage/write-journal.js';

/** A candidate the operator picked with a button. */
export type Choice = { field: string; id: number };
export type TurnInput = {
  /** The message, including anything read from its attachments or forward. */
  text: string;
  /** The operator's own words. */
  operatorText: string;
  senderId: string;
  /** The open request this message is about, if any. */
  request?: Conversation;
  /** Another open request this turn cannot change, described for the agent; it blocks new work. */
  locked?: string;
  /** A new request, for when the agent starts one. */
  fresh: (kind: 'order' | 'customer') => Conversation;
};
/**
 * What a turn produced. `text` is what is sent: the agent's `reply` and the application's draft or summary. `replaced` is
 * the open request a new one of the other kind replaced; `blocked` means a locked request stopped new work.
 */
export type TurnOutput = { text: string; reply: string; locale: AppConfig['locale']; order?: Conversation; replaced?: Conversation; cancel?: boolean; blocked?: boolean };
export type ConversationEngine = {
  turn: (input: TurnInput) => Promise<TurnOutput>;
  /** Re-validates a request with the APIs, applying a candidate picked with a button when given. */
  revise: (previous: Conversation, choice?: Choice) => Promise<{ order: Conversation; text: string }>;
  matchingPolicy?: string;
  record?: (id: number, plan: ReplyPlan) => Promise<void>;
};
export function policyFingerprint(config: AppConfig) { return createHash('sha256').update(JSON.stringify(config)).digest('hex'); }
function chunks(text: string): string[] {
  const result: string[] = [];
  while (text.length > 3500) { result.push(text.slice(0, 3500)); text = text.slice(3500); }
  if (text) result.push(text);
  return result;
}

type Reply = Pick<ReplyPlan, 'texts' | 'agentText' | 'order' | 'pdfOrderId' | 'prompt' | 'cancelled' | 'voidAll'>;
type ButtonAction = Extract<Action, { kind: 'confirmOrder' | 'confirmCustomer' | 'review' | 'pick' }>;
type Loaded = { linked?: Conversation; active?: Conversation };
const say = (text: string, order?: Conversation): Reply => ({ texts: [text], order });
/** Requests a message can still change. A reviewed order reopens when edited; a finished customer request cannot. */
const editable = (c: Conversation) => ['new', 'suspended', 'ready'].includes(c.status) || (c.status === 'reviewed' && c.kind !== 'customer');

/** Merges the other parts of a Telegram album into its first message. */
function withAlbum(event: MessageEvent, parts: MessageEvent[]): MessageEvent {
  if (!parts.length) return event;
  return { ...event, text: [event, ...parts].map(p => p.text).find(Boolean) ?? '', attachments: [event, ...parts].flatMap(p => p.attachments ?? []) };
}

export class TelegramController {
  private readonly policy: string;
  private locale: AppConfig['locale'];
  constructor(private readonly config: AppConfig, private readonly username: string, private readonly store: TelegramStore,
    private readonly engine: ConversationEngine,
    private readonly send: (text: string, replyTo: number, keyboard?: Keyboard) => Promise<{ message_id: number }>,
    private readonly createCustomer?: (previous: Conversation) => Promise<string>,
    private readonly saveOrder?: (previous: Conversation) => Promise<SavedOrder>,
    private readonly sendPdf?: (orderId: number, locale?: AppConfig['locale']) => Promise<{ message_id: number }>,
    private readonly buttons?: { answer: (id: string) => Promise<unknown>; clear: (messageId: number) => Promise<unknown> },
    private readonly media?: MediaReader) {
    this.policy = engine.matchingPolicy ? createHash('sha256').update(JSON.stringify({ config, matchingPolicy: engine.matchingPolicy })).digest('hex') : policyFingerprint(config);
    this.locale = config.locale;
  }

  private t(itText: string, en: string) { return translate({ locale: this.locale }, itText, en); }

  /**
   * Caller must serialize updates. Polling entry point uses an exclusive process lock.
   * `album` holds the other updates of the same Telegram album; they are answered together with this one.
   */
  async handle(update: { update_id: number }, album: { update_id: number }[] = []) {
    const id = update.update_id;
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid update identifier');
    let entry = await this.store.update(id);
    this.locale = entry?.plan.locale ?? await this.store.locale() ?? this.config.locale;
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
            // The button answered the question it was asked, so that answer is the operator's instruction.
            action = { kind: 'converse', text: read.text, operatorText: active ? this.t('Sì, aggiungilo alla richiesta aperta.', 'Yes, add it to the open request.') : this.t('Sì, prepara un ordine da questo.', 'Yes, prepare an order from this.') };
          } else action = result.failed;
        }
      } else if (callback && callback.action.kind === 'cancelAll') {
        event = callback.event; action = callback.action;
        loaded.active = await this.store.activeRequest();
      } else if (callback) {
        const target = callback.target!;
        const link = await this.store.link(callback.messageId);
        loaded.linked = await this.store.order(target.orderId);
        if (!link || link.orderId !== target.orderId || link.revision !== target.revision || loaded.linked?.revision !== target.revision) {
          await this.buttons?.clear(callback.messageId).catch(() => undefined);
          await this.store.advance(id + 1); return;
        }
        event = callback.event; action = callback.action;
        loaded.active = await this.store.activeRequest();
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
            action = routeMessage(event, { config: this.config, botUsername: this.username, link, ...loaded, operatorText: unread.text });
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
      await this.store.plan(id, { replyTo: event.messageId, ...reply, activeOrderId: loaded.active?.orderId, locale: this.locale, incomingText: event.text, senderId: event.senderId, receivedAt: new Date().toISOString() }, effects);
      entry = (await this.store.update(id))!;
    }
    if (entry.sending) throw new Error(`Telegram delivery uncertain for update ${id}. Use telegram:recover after inspecting the group.`);
    while (!entry.done) {
      await this.store.beginSend(id);
      const text = entry.plan.texts[entry.next];
      const sent = text
        ? await this.send(text, entry.plan.replyTo, entry.next === entry.plan.texts.length - 1 ? this.keyboard(entry.plan) : undefined)
        : this.sendPdf && entry.plan.pdfOrderId !== undefined
          ? await this.sendPdf(entry.plan.pdfOrderId, this.locale)
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
    try { return { read: await this.media(event, this.locale) }; }
    catch (error) {
      return fail(error instanceof MediaError ? error.message : this.t('Non sono riuscito a leggere l’allegato. Nessun dato salvato: invialo di nuovo o scrivi i dettagli.', 'I could not read the attachment. Nothing was saved: send it again or type the details.'));
    }
  }

  private async respond(action: Exclude<Action, { kind: 'ignore' | 'pending' }>, event: MessageEvent, id: number, { linked, active }: Loaded): Promise<Reply> {
    const load = async (orderId: string) => orderId === linked?.orderId ? linked : orderId === active?.orderId ? active : this.store.order(orderId);
    switch (action.kind) {
      case 'answer': return { texts: chunks(action.text) };
      case 'stale': return say(this.t('Questo messaggio riguarda una versione precedente. Rispondi al riepilogo più recente.', 'This message refers to an older revision. Reply to the latest summary.'));
      case 'prompt': return {
        texts: [active ? this.t('Aggiungo questo alla richiesta aperta?', 'Add this to the open request?') : this.t('Preparo un ordine da questo?', 'Prepare an order from this?')],
        prompt: { message: event.messageId, active: Boolean(active) },
      };
      case 'converse': return this.converse(action, event, id, action.target ? linked : active);
      case 'cancel': return this.cancel(action.target ? await load(action.target.orderId) : active);
      case 'cancelAll': return action.target && (active?.orderId !== action.target.orderId || active.revision !== action.target.revision)
        ? this.openList(this.t('Le richieste aperte sono cambiate.', 'The open requests have changed.'))
        : this.cancelAll();
      default: {
        const previous = await load(action.target.orderId);
        if (!previous || action.target.revision !== previous.revision) return say(this.t('Questo pulsante riguarda una versione precedente. Usa il riepilogo più recente.', 'This button belongs to an older revision. Use the latest summary.'));
        if (previous.status === 'cancelled') return say(this.t('Richiesta annullata. Scrivimi se ne vuoi iniziare una nuova.', 'This request was cancelled. Tell me if you want to start a new one.'), previous);
        // A button on a request from an earlier configuration shows it rechecked, to be confirmed anew.
        if (previous.policy !== this.policy) {
          if (!editable(previous)) return say(this.t('La configurazione è cambiata. Inizia un nuovo ordine per ricalcolare i dati.', 'Configuration changed. Start a new order to recalculate its data.'));
          try { const { request, notice, draft } = await this.current(previous); return { texts: chunks(`${notice}\n\n${draft}`), order: request }; }
          catch { return say(this.t('La configurazione è cambiata e non sono riuscito a ricontrollare la richiesta. Nessun dato salvato: riprova.', 'The configuration changed and I could not check the request again. Nothing was saved: try again.')); }
        }
        const localized = { ...previous, locale: this.locale };
        if (action.kind === 'pick') return this.pick(action, localized);
        return kindOf(previous) === 'customer' ? this.customerAction(action, localized) : this.orderAction(action, localized);
      }
    }
  }

  /** A new request, numbered after the update that starts it. */
  private fresh(kind: 'order' | 'customer', event: MessageEvent, id: number): Conversation {
    return { orderId: `u${id}`, startedBy: event.senderId, startedAt: new Date().toISOString(), revision: 0, status: 'new', ...(kind === 'customer' ? { kind: 'customer' as const } : {}), draft: draftSchema.parse({}), policy: this.policy };
  }

  /**
   * A request prepared under an earlier configuration, checked again under the current one so its context stays. The
   * notice and the rechecked draft are shown with whatever comes next.
   */
  private async current(request: Conversation): Promise<{ request: Conversation; notice?: string; draft?: string }> {
    if (request.policy === this.policy) return { request };
    const rechecked = await this.engine.revise({ ...request, policy: this.policy, locale: this.locale });
    return { request: rechecked.order, notice: this.t('La configurazione è cambiata: ho ricontrollato la richiesta aperta.', 'The configuration changed: I checked the open request again.'), draft: rechecked.text };
  }

  /** The agent's turn. It works on the selected request when that can still change, and may start one when none is open. */
  private async converse(action: Extract<Action, { kind: 'converse' }>, event: MessageEvent, id: number, selected?: Conversation): Promise<Reply> {
    const failed = say(this.t('Non riesco a elaborare il messaggio. Riprova; la richiesta aperta non è stata modificata.', 'Unable to process this message. Please retry; the open request is unchanged.'));
    let request = selected && editable(selected) ? selected : undefined, notice: string | undefined, draft: string | undefined;
    if (request) {
      try { ({ request, notice, draft } = await this.current(request)); } catch { return failed; }
    }
    const rechecked = notice ? request : undefined;
    const others = (await this.store.openRequests()).filter(c => c.orderId !== request?.orderId);
    let out: TurnOutput;
    try {
      out = await this.engine.turn({ text: action.text, operatorText: action.operatorText, senderId: event.senderId, request, fresh: kind => this.fresh(kind, event, id),
        ...(!request && others.length ? { locked: others.map(c => this.describe(c)).join('; ') } : {}) });
    } catch {
      return rechecked ? { texts: chunks([notice, draft, failed.texts[0]].join('\n\n')), order: rechecked } : failed;
    }
    this.locale = out.locale;
    // Unless the agent changed it, the rechecked draft is shown after its reply.
    const around = (texts: string[]) => chunks([notice, ...texts, out.order ? undefined : draft].filter(Boolean).join('\n\n'));
    if (out.cancel) { const reply = this.cancel(request); return { ...reply, texts: chunks([notice, ...reply.texts].filter(Boolean).join('\n\n')) }; }
    if (out.blocked) return { ...await this.openList(out.text, request ? [request, ...others] : others), agentText: out.reply, ...(rechecked ? { order: rechecked } : {}) };
    return { texts: around([out.text]), agentText: out.reply, order: out.order ?? rechecked, ...(out.replaced ? { cancelled: [{ ...out.replaced, status: 'cancelled' as const }] } : {}) };
  }

  /** A candidate button: the APIs check the operator's pick, with no model involved. */
  private async pick(action: Extract<Action, { kind: 'pick' }>, previous: Conversation): Promise<Reply> {
    if (!editable(previous)) return say(this.t('Questa richiesta non si può più modificare.', 'This request can no longer be changed.'), previous);
    try {
      const result = await this.engine.revise(previous, action.choice);
      return { texts: chunks(result.text), order: result.order };
    } catch {
      return say(this.t('Non sono riuscito ad applicare la scelta. Nessun dato salvato: riprova.', 'I could not apply that choice. Nothing was saved: try again.'), previous);
    }
  }

  private cancel(previous?: Conversation): Reply {
    if (!previous || previous.status === 'cancelled') return say(this.t('Nessuna richiesta aperta da annullare.', 'No open request to cancel.'));
    if (previous.status === 'saving') return say(this.t('Salvataggio da verificare in Fatture in Cloud: non si può annullare qui.', 'Save needs checking in Fatture in Cloud; it cannot be cancelled here.'), previous);
    if (previous.status === 'saved' || (previous.kind === 'customer' && previous.status === 'reviewed')) return say(this.t('Già salvato in Fatture in Cloud: non si può annullare qui.', 'Already saved in Fatture in Cloud; it cannot be cancelled here.'), previous);
    return say(this.t('Annullato. Nulla è stato salvato.', 'Cancelled. Nothing was saved.'), { ...previous, status: 'cancelled' });
  }

  /** Lists every open request so a forgotten one cannot silently block new work, with a button to void them all. */
  private async openList(note?: string, open?: Conversation[]): Promise<Reply> {
    open ??= await this.store.openRequests();
    if (!open.length) return say([note, this.t('Nessuna richiesta aperta.', 'No open requests.')].filter(Boolean).join('\n'));
    const shown = open.slice(0, 10).map(c => `• ${this.describe(c)}`);
    if (open.length > shown.length) shown.push(this.t(`…e altre ${open.length - shown.length}`, `…and ${open.length - shown.length} more`));
    const voidable = open.filter(c => c.status !== 'saving').length;
    const lines = [
      ...(note ? [note, ''] : []),
      open.length === 1 ? this.t('C’è già una richiesta aperta:', 'A request is already open:') : this.t(`Ci sono ${open.length} richieste aperte:`, `${open.length} requests are open:`),
      ...shown, '',
      voidable
        ? voidable === 1
          ? this.t('Completa quella richiesta, oppure annullala con il pulsante.', 'Complete that request, or cancel it with the button.')
          : this.t('Completa quella che ti serve, oppure annullale tutte con il pulsante.', 'Complete the one you need, or cancel them all with the button.')
        : this.t('Verifica il salvataggio in Fatture in Cloud prima di iniziarne un’altra.', 'Check the save in Fatture in Cloud before starting another.'),
    ];
    return { texts: chunks(lines.join('\n')), ...(voidable ? { voidAll: { orderId: open[0]!.orderId, revision: open[0]!.revision, count: voidable } } : {}) };
  }

  private async cancelAll(): Promise<Reply> {
    const open = await this.store.openRequests();
    const voided = open.filter(c => c.status !== 'saving').map(c => ({ ...c, status: 'cancelled' as const }));
    const unverified = open.length - voided.length;
    if (!open.length) return say(this.t('Nessuna richiesta aperta da annullare.', 'No open request to cancel.'));
    const text = [
      voided.length === 1 ? this.t('Annullata 1 richiesta. Nulla è stato salvato.', 'Cancelled 1 request. Nothing was saved.')
        : this.t(`Annullate ${voided.length} richieste. Nulla è stato salvato.`, `Cancelled ${voided.length} requests. Nothing was saved.`),
      ...(unverified ? [unverified === 1
        ? this.t('1 salvataggio da verificare in Fatture in Cloud resta aperto.', '1 save needing a check in Fatture in Cloud stays open.')
        : this.t(`${unverified} salvataggi da verificare in Fatture in Cloud restano aperti.`, `${unverified} saves needing a check in Fatture in Cloud stay open.`)] : []),
    ].join('\n');
    return { texts: [text], cancelled: voided };
  }

  private describe(c: Conversation): string {
    const who = (c.kind === 'customer' ? c.draft.newClient?.name : undefined) || c.draft.clientQuery;
    // "Ordine" and "nuovo cliente" are masculine; agree with that label, not with "richiesta".
    const status = {
      new: this.t('appena iniziato', 'just started'), suspended: this.t('in attesa di dettagli', 'waiting for details'),
      ready: this.t('pronto da confermare', 'ready to confirm'), saving: this.t('salvataggio da verificare', 'save needs checking'),
    }[c.status as 'new'] ?? c.status;
    const date = c.startedAt ? new Date(c.startedAt).toLocaleDateString(this.locale === 'it' ? 'it-IT' : 'en-GB', { day: '2-digit', month: '2-digit' }) : undefined;
    return [
      c.kind === 'customer' ? this.t('Nuovo cliente', 'New customer') : this.t('Ordine', 'Order'),
      who || undefined, status, date, c.policy !== this.policy ? this.t('configurazione precedente', 'earlier configuration') : undefined,
    ].filter(Boolean).join(' — ');
  }

  private async orderAction(action: Exclude<ButtonAction, { kind: 'pick' }>, previous: Conversation): Promise<Reply> {
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
    if (action.kind === 'review' && previous.status === 'ready') return say(this.t('Revisione registrata. Nessun ordine salvato o inviato al cliente (modalità anteprima).', 'Review recorded. No order saved or sent to the customer (preview mode).'), { ...previous, status: 'reviewed' });
    return say(previous.status === 'reviewed' ? this.t('Ordine già revisionato. Rispondi con le modifiche per riaprirlo.', 'Order already reviewed. Reply with changes to reopen it.')
      : this.t('Completa prima i dati mancanti.', 'Resolve missing details first.'), previous);
  }

  private async customerAction(action: Exclude<ButtonAction, { kind: 'pick' }>, previous: Conversation): Promise<Reply> {
    if (previous.status === 'saving') return say(this.t('Creazione cliente da verificare in Fatture in Cloud. Modifiche e nuovi tentativi bloccati fino alla riconciliazione.', 'Customer creation needs checking in Fatture in Cloud. Edits and retries are blocked until reconciliation.'), previous);
    if (previous.status === 'reviewed') return say(this.t('Richiesta cliente conclusa.', 'Customer request completed.'), previous);
    if (action.kind !== 'confirmCustomer' || previous.status !== 'ready' || !this.createCustomer) return say(this.t('Creazione non disponibile: completa i dati e controlla il riepilogo.', 'Creation unavailable: complete the details and check the summary.'), previous);
    try {
      return say(await traceOperation('Confirmed customer save', () => this.createCustomer!(previous), { orderId: previous.orderId, revision: previous.revision, policy: previous.policy }), { ...previous, status: 'reviewed', revision: previous.revision + 1 });
    } catch (error) {
      if (error instanceof PreflightFailed) return say(this.t('Controlli temporaneamente non disponibili. Nessun salvataggio tentato: puoi riprovare a confermare.', 'Checks are temporarily unavailable. No save was attempted: you can confirm again.'), previous);
      return say(this.t('Creazione cliente non confermata. Non ripetere la richiesta: controlla Fatture in Cloud prima di riprovare. Nessun ordine o fattura creato.', 'Customer creation was not confirmed. Do not repeat the request: reconcile Fatture in Cloud before retrying. No order or invoice created.'), { ...previous, status: 'saving' });
    }
  }

  private keyboard({ order, prompt, voidAll }: ReplyPlan): Keyboard | undefined {
    if (voidAll) return { inline_keyboard: [[{ text: voidAll.count === 1 ? this.t('🗑 Annulla', '🗑 Cancel') : this.t(`🗑 Annulla tutte (${voidAll.count})`, `🗑 Cancel all (${voidAll.count})`), callback_data: callbackData('cancelall', voidAll) }]] };
    if (prompt) return { inline_keyboard: [[
      { text: this.t('✅ Sì', '✅ Yes'), callback_data: mediaCallbackData(prompt.message, true) },
      { text: this.t('✖️ No', '✖️ No'), callback_data: mediaCallbackData(prompt.message, false) },
    ]] };
    if (!order || !['new', 'suspended', 'ready'].includes(order.status)) return undefined;
    const link = { orderId: order.orderId, revision: order.revision };
    // One button per candidate the operator can pick, labelled with the line it settles when there are several.
    const picks = (order.status === 'suspended' ? order.issues ?? [] : []).filter(pickable).flatMap(issue => {
      const line = lineIndex(issue.field);
      const about = line === undefined ? '' : `${line + 1}. `;
      return issue.candidates!.slice(0, MAX_CHOICES).map(c => [{ text: `${about}${c.label}`.slice(0, 60), callback_data: pickData(link, issue.field, c.id) }]);
    });
    const row = [];
    if (order.status === 'ready' && (order.kind === 'customer' ? this.createCustomer : this.saveOrder && this.sendPdf)) row.push({ text: this.t('✅ Conferma e salva', '✅ Confirm and save'), callback_data: callbackData(order.kind === 'customer' ? 'customer' : 'save', link) });
    else if (order.status === 'ready' && order.kind !== 'customer') row.push({ text: this.t('👀 Segna come controllato', '👀 Mark as checked'), callback_data: callbackData('review', link) });
    row.push({ text: this.t('❌ Annulla', '❌ Cancel'), callback_data: callbackData('cancel', link) });
    return { inline_keyboard: [...picks, row] };
  }
}
