import { createHash } from 'node:crypto';
import { traceOperation } from '../assistant/execution-trace.js';
import type { AppConfig } from '../config/schema.js';
import { copy, type CopyKey, type CopyVars } from './locales/index.js';
import { callbackData, mediaCallbackData, pickData } from './callbacks.js';
import { inboundOf } from './inbound.js';
import type { MessageEvent, Keyboard } from './contract.js';
import { asksFirst, routeMessage, type Action } from './routing.js';
import { kindOf, TelegramStore, type Conversation, type PlanEffects, type ReplyPlan } from './store.js';
import { MediaError, type MediaReader, type ReadMedia } from './media.js';
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

  /** Operator-facing name of the invoicing system, from config. */
  private books() { return this.config.invoicing.label; }

  private t(key: CopyKey, vars?: CopyVars) { return copy(this.locale, key, vars); }

  /**
   * Caller must serialize updates. Polling entry point uses an exclusive process lock.
   * `album` holds the other updates of the same Telegram album; they are answered together with this one.
   */
  async handle(update: { update_id: number }, album: { update_id: number }[] = []) {
    const id = update.update_id;
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid update identifier');
    let entry = await this.store.update(id);
    this.locale = entry?.plan.locale ?? await this.store.locale() ?? this.config.locale;
    const callback = inboundOf().parseCallback(update, this.config);
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
          action = { kind: 'answer', text: this.t('ignore') };
        } else if (pending.value.target === undefined || (pending.value.target === null
          ? loaded.active !== undefined
          : loaded.active?.orderId !== pending.value.target.orderId || loaded.active.revision !== pending.value.target.revision)) {
          effects.consume = pending.message;
          action = { kind: 'answer', text: this.t('attachmentStale') };
        } else {
          const result = pending.value.read ? { read: pending.value.read } : await this.read(pending.value.event);
          if ('read' in result) {
            read = result.read;
            event = { ...event, text: read.text };
            effects.consume = pending.message;
            const active = loaded.active;
            // The button answered the question it was asked, so that answer is the operator's instruction.
            action = { kind: 'converse', text: read.text, operatorText: active ? this.t('addToOpen') : this.t('prepareFromThis') };
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
        event = inboundOf().parseMessage(update, this.config);
        if (!event) { await this.store.advance(id + 1); return; }
        const original = event;
        const parts = album.map(u => inboundOf().parseMessage(u, this.config)).filter((p): p is MessageEvent => p !== null && p.album === original.album);
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
    if (entry.sending) throw new Error(`Channel delivery uncertain for update ${id}. Use telegram:recover after inspecting the group.`);
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
    if (!this.media) return fail(this.t('mediaDisabled'));
    try { return { read: await this.media(event, this.locale) }; }
    catch (error) {
      return fail(error instanceof MediaError ? error.message : this.t('attachmentUnreadable'));
    }
  }

  private async respond(action: Exclude<Action, { kind: 'ignore' | 'pending' }>, event: MessageEvent, id: number, { linked, active }: Loaded): Promise<Reply> {
    const load = async (orderId: string) => orderId === linked?.orderId ? linked : orderId === active?.orderId ? active : this.store.order(orderId);
    switch (action.kind) {
      case 'answer': return { texts: chunks(action.text) };
      case 'stale': return say(this.t('staleMessage'));
      case 'prompt': return {
        texts: [active ? this.t('addThisToOpen') : this.t('prepareOrderFromThis')],
        prompt: { message: event.messageId, active: Boolean(active) },
      };
      case 'converse': return this.converse(action, event, id, action.target ? linked : active);
      case 'cancel': return this.cancel(action.target ? await load(action.target.orderId) : active);
      case 'cancelAll': return action.target && (active?.orderId !== action.target.orderId || active.revision !== action.target.revision)
        ? this.openList(this.t('openRequestsChanged'))
        : this.cancelAll();
      default: {
        const previous = await load(action.target.orderId);
        if (!previous || action.target.revision !== previous.revision) return say(this.t('staleButton'));
        if (previous.status === 'cancelled') return say(this.t('requestCancelled'), previous);
        // A button on a request from an earlier configuration shows it rechecked, to be confirmed anew.
        if (previous.policy !== this.policy) {
          if (!editable(previous)) return say(this.t('configChangedRestart'));
          try { const { request, notice, draft } = await this.current(previous); return { texts: chunks(`${notice}\n\n${draft}`), order: request }; }
          catch { return say(this.t('configChangedRecheckFailed')); }
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
    return { request: rechecked.order, notice: this.t('configRechecked'), draft: rechecked.text };
  }

  /** The agent's turn. It works on the selected request when that can still change, and may start one when none is open. */
  private async converse(action: Extract<Action, { kind: 'converse' }>, event: MessageEvent, id: number, selected?: Conversation): Promise<Reply> {
    const failed = say(this.t('processFailed'));
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
    if (!editable(previous)) return say(this.t('requestLocked'), previous);
    try {
      const result = await this.engine.revise(previous, action.choice);
      return { texts: chunks(result.text), order: result.order };
    } catch {
      return say(this.t('choiceFailed'), previous);
    }
  }

  private cancel(previous?: Conversation): Reply {
    if (!previous || previous.status === 'cancelled') return say(this.t('nothingToCancel'));
    if (previous.status === 'saving') return say(this.t('saveNeedsCheck', { books: this.books() }), previous);
    if (previous.status === 'saved' || (previous.kind === 'customer' && previous.status === 'reviewed')) return say(this.t('alreadySaved', { books: this.books() }), previous);
    return say(this.t('cancelledNothingSaved'), { ...previous, status: 'cancelled' });
  }

  /** Lists every open request so a forgotten one cannot silently block new work, with a button to void them all. */
  private async openList(note?: string, open?: Conversation[]): Promise<Reply> {
    open ??= await this.store.openRequests();
    if (!open.length) return say([note, this.t('noOpenRequests')].filter(Boolean).join('\n'));
    const shown = open.slice(0, 10).map(c => `• ${this.describe(c)}`);
    if (open.length > shown.length) shown.push(this.t('andMore', { count: open.length - shown.length }));
    const voidable = open.filter(c => c.status !== 'saving').length;
    const lines = [
      ...(note ? [note, ''] : []),
      open.length === 1 ? this.t('oneAlreadyOpen') : this.t('manyOpen', { count: open.length }),
      ...shown, '',
      voidable
        ? voidable === 1
          ? this.t('completeOrCancelOne')
          : this.t('completeOrCancelAll')
        : this.t('checkSaveBeforeAnother', { books: this.books() }),
    ];
    return { texts: chunks(lines.join('\n')), ...(voidable ? { voidAll: { orderId: open[0]!.orderId, revision: open[0]!.revision, count: voidable } } : {}) };
  }

  private async cancelAll(): Promise<Reply> {
    const open = await this.store.openRequests();
    const voided = open.filter(c => c.status !== 'saving').map(c => ({ ...c, status: 'cancelled' as const }));
    const unverified = open.length - voided.length;
    if (!open.length) return say(this.t('nothingToCancel'));
    const text = [
      voided.length === 1 ? this.t('cancelledOne')
        : this.t('cancelledMany', { count: voided.length }),
      ...(unverified ? [unverified === 1
        ? this.t('oneSaveStaysOpen', { books: this.books() })
        : this.t('manySavesStayOpen', { count: unverified, books: this.books() })] : []),
    ].join('\n');
    return { texts: [text], cancelled: voided };
  }

  private describe(c: Conversation): string {
    const who = (c.kind === 'customer' ? c.draft.newClient?.name : undefined) || c.draft.clientQuery;
    // "Ordine" and "nuovo cliente" are masculine; agree with that label, not with "richiesta".
    const status = {
      new: this.t('statusNew'), suspended: this.t('statusWaiting'),
      ready: this.t('statusReady'), saving: this.t('statusSaving'),
    }[c.status as 'new'] ?? c.status;
    const date = c.startedAt ? new Date(c.startedAt).toLocaleDateString(this.locale === 'it' ? 'it-IT' : 'en-GB', { day: '2-digit', month: '2-digit' }) : undefined;
    return [
      c.kind === 'customer' ? this.t('newCustomer') : this.t('orderLabel'),
      who || undefined, status, date, c.policy !== this.policy ? this.t('earlierConfig') : undefined,
    ].filter(Boolean).join(' — ');
  }

  private async orderAction(action: Exclude<ButtonAction, { kind: 'pick' }>, previous: Conversation): Promise<Reply> {
    if (action.kind === 'confirmOrder') {
      if (previous.status === 'saved') return say(this.t('orderAlreadySaved', { number: previous.savedOrder?.number ?? '' }), previous);
      if (!this.saveOrder || !this.sendPdf || !['ready', 'saving'].includes(previous.status) || !previous.prepared) return say(this.t('confirmLatest'), previous);
      try {
        const saved = await traceOperation('Confirmed order save', () => this.saveOrder!(previous), { orderId: previous.orderId, revision: previous.revision, policy: previous.policy });
        return { texts: [this.t('orderSaved', { number: saved.number, books: this.books() })], pdfOrderId: saved.id, order: { ...previous, status: 'saved', savedOrder: saved, revision: previous.revision + 1 } };
      } catch (error) {
        if (error instanceof PreflightFailed) return say(error.needsReview
          ? this.t('detailsChanged')
          : this.t('checksUnavailable'),
          error.needsReview ? { ...previous, revision: previous.revision + 1, status: 'new', prepared: undefined, totals: undefined } : previous);
        return say(this.t('saveNotConfirmed', { books: this.books() }), { ...previous, status: 'saving' });
      }
    }
    if (action.kind === 'review' && previous.status === 'ready') return say(this.t('reviewRecorded'), { ...previous, status: 'reviewed' });
    return say(previous.status === 'reviewed' ? this.t('alreadyReviewed')
      : this.t('resolveMissing'), previous);
  }

  private async customerAction(action: Exclude<ButtonAction, { kind: 'pick' }>, previous: Conversation): Promise<Reply> {
    if (previous.status === 'saving') return say(this.t('customerSaveNeedsCheck', { books: this.books() }), previous);
    if (previous.status === 'reviewed') return say(this.t('customerCompleted'), previous);
    if (action.kind !== 'confirmCustomer' || previous.status !== 'ready' || !this.createCustomer) return say(this.t('creationUnavailable'), previous);
    try {
      return say(await traceOperation('Confirmed customer save', () => this.createCustomer!(previous), { orderId: previous.orderId, revision: previous.revision, policy: previous.policy }), { ...previous, status: 'reviewed', revision: previous.revision + 1 });
    } catch (error) {
      if (error instanceof PreflightFailed) return say(this.t('checksUnavailable'), previous);
      return say(this.t('customerNotConfirmed', { books: this.books() }), { ...previous, status: 'saving' });
    }
  }

  private keyboard({ order, prompt, voidAll }: ReplyPlan): Keyboard | undefined {
    if (voidAll) return { inline_keyboard: [[{ text: voidAll.count === 1 ? this.t('cancelOne') : this.t('cancelAll', { count: voidAll.count }), callback_data: callbackData('cancelall', voidAll) }]] };
    if (prompt) return { inline_keyboard: [[
      { text: this.t('yes'), callback_data: mediaCallbackData(prompt.message, true) },
      { text: this.t('no'), callback_data: mediaCallbackData(prompt.message, false) },
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
    if (order.status === 'ready' && (order.kind === 'customer' ? this.createCustomer : this.saveOrder && this.sendPdf)) row.push({ text: this.t('confirmAndSave'), callback_data: callbackData(order.kind === 'customer' ? 'customer' : 'save', link) });
    else if (order.status === 'ready' && order.kind !== 'customer') row.push({ text: this.t('markChecked'), callback_data: callbackData('review', link) });
    row.push({ text: this.t('cancelButton'), callback_data: callbackData('cancel', link) });
    return { inline_keyboard: [...picks, row] };
  }
}
