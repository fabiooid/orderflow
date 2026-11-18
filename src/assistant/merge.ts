import { draftSchema, type OrderDraft } from '../domain/types.js';
import { normalize } from '../domain/matching.js';
import type { ReadingLine } from '../documents/product-lines.js';
import { customerNamedInRequest, statedShipping } from './intent.js';

export type LinePatch = OrderDraft['lines'][number] & { op?: 'add' | 'edit' | 'replace' | 'delete' };

const lineKey = (line: Pick<OrderDraft['lines'][number], 'query' | 'quantity' | 'tester'>) =>
  `${normalize(line.query)}|${line.quantity ?? ''}|${line.tester ? 't' : ''}`;

/** Assign `L1`, `L2`, … to lines that were stored before refs existed. Existing refs are kept. */
export function ensureLineRefs(lines: OrderDraft['lines']): OrderDraft['lines'] {
  const used = new Set(lines.map(line => line.ref).filter((ref): ref is string => !!ref));
  let next = 1;
  const alloc = () => {
    let ref = `L${next++}`;
    while (used.has(ref)) ref = `L${next++}`;
    used.add(ref);
    return ref;
  };
  return lines.map(line => line.ref ? line : { ...line, ref: alloc() });
}

function sameLines(left: OrderDraft['lines'], right: ReadingLine[] | OrderDraft['lines']) {
  if (left.length !== right.length) return false;
  const remaining = right.map(line => lineKey(line));
  for (const line of left) {
    const at = remaining.indexOf(lineKey(line));
    if (at < 0) return false;
    remaining.splice(at, 1);
  }
  return true;
}

function applyIncomingLines(base: OrderDraft['lines'], incoming: LinePatch[]): OrderDraft['lines'] {
  if (!incoming.length) return ensureLineRefs(base);
  const hasRefOp = incoming.some(line => line.ref || line.op);
  if (!hasRefOp) {
    if (base.length && sameLines(base, incoming)) return ensureLineRefs(base);
    return ensureLineRefs(incoming.map(({ op: _op, ...line }) => line));
  }
  const byRef = new Map(base.filter(line => line.ref).map(line => [line.ref!, { ...line }]));
  const unused = base.filter(line => !line.ref || !incoming.some(patch => patch.ref === line.ref));
  const next: OrderDraft['lines'] = [];
  for (const patch of incoming) {
    const { op, ...rest } = patch;
    if (op === 'delete') {
      if (patch.ref) byRef.delete(patch.ref);
      continue;
    }
    const current = patch.ref ? byRef.get(patch.ref) : undefined;
    if (op === 'replace' || !current) {
      next.push({ ...rest });
      if (patch.ref) byRef.delete(patch.ref);
      continue;
    }
    const queryChanged = rest.query !== current.query || rest.tester !== current.tester;
    next.push({
      ...current,
      ...rest,
      ...(queryChanged && rest.productId === undefined ? { productId: undefined } : {}),
    });
    byRef.delete(patch.ref!);
  }
  if (!incoming.some(line => line.op === 'replace' && !line.ref) && unused.length) {
    // Patch edits keep unmatched existing lines (omission is not delete).
    next.push(...unused.filter(line => !next.some(kept => kept.ref && kept.ref === line.ref)));
  }
  return ensureLineRefs(next);
}

export type MergeInput = {
  base?: OrderDraft;
  incoming: OrderDraft;
  incomingLines?: LinePatch[];
  attachmentLines?: ReadingLine[];
  operatorWords: string;
  attachmentText?: string;
  isNewRequest: boolean;
};

/**
 * One merge of attachment facts and model edits into the current request's draft.
 * A new request starts empty. Omitted fields keep the open draft; an explicit 0 shipping stays.
 */
export function mergeOrderDraft(input: MergeInput): OrderDraft {
  const incoming = draftSchema.parse(input.incoming);
  const base = input.base ? draftSchema.parse(structuredClone(input.base)) : draftSchema.parse({});
  const start = input.isNewRequest ? draftSchema.parse({}) : base;
  const attachment = input.attachmentLines ?? [];

  let lines = start.lines;
  if (!lines.length && attachment.length) lines = attachment.map(line => ({ ...line }));
  lines = applyIncomingLines(lines, input.incomingLines ?? incoming.lines);
  if (!incoming.lines.length && attachment.length && lines.length && sameLines(lines, attachment)) {
    // Repeated attachment of the same rows is not a second set of lines.
    lines = ensureLineRefs(lines);
  } else if (!incoming.lines.length && attachment.length && !lines.length) {
    lines = ensureLineRefs(attachment.map(line => ({ ...line })));
  }
  lines = ensureLineRefs(lines);

  const named = incoming.clientQuery.trim() || incoming.newClient?.name?.trim() || '';
  const keepIncomingCustomer = !input.isNewRequest
    || customerNamedInRequest(named, input.operatorWords, input.attachmentText)
    || !!incoming.newClient;
  const clientQuery = keepIncomingCustomer && incoming.clientQuery.trim()
    ? incoming.clientQuery
    : (start.clientQuery.trim() ? start.clientQuery : '');
  const newClient = keepIncomingCustomer && incoming.newClient ? incoming.newClient : start.newClient;
  const clientId = start.clientId;

  const stated = statedShipping(input.operatorWords);
  const shippingPrice = input.isNewRequest
    ? (incoming.shippingPrice !== undefined && stated !== undefined ? incoming.shippingPrice : stated)
    : incoming.shippingPrice !== undefined ? incoming.shippingPrice : start.shippingPrice;

  const notes = incoming.notes.trim() ? incoming.notes : start.notes;
  const draft = draftSchema.parse({
    ...start,
    ...incoming,
    clientQuery,
    ...(clientId && !incoming.clientId ? { clientId } : {}),
    ...(newClient ? { newClient } : { newClient: undefined }),
    lines,
    ...(shippingPrice !== undefined ? { shippingPrice } : { shippingPrice: undefined }),
    notes,
  });
  if (input.isNewRequest) delete draft.clientId;
  if (!keepIncomingCustomer) {
    delete draft.clientId;
    if (!start.clientQuery.trim()) draft.clientQuery = '';
    if (!start.newClient) delete draft.newClient;
  }
  if (incoming.clientId && incoming.clientId === start.clientId) draft.clientId = start.clientId;
  return draft;
}
