import { draftSchema, type OrderDraft } from '../domain/types.js';
import { lineWantsTester, normalize, testerRestatementOf } from '../domain/matching.js';
import type { ReadingLine } from '../documents/product-lines.js';
import { customerNamedInRequest, operatorAskedToCreateCustomer, statedNote, statedShipping } from './intent.js';

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

function uniqueByLineKey<T extends { query: string; quantity?: number; tester?: boolean }>(lines: T[]): T[] {
  const seen = new Set<string>();
  return lines.filter(line => {
    const key = lineKey(line);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type KeyedLine = { query: string; quantity?: number; tester?: boolean };

/**
 * Bind model tester wording to an unmatched source tester, or drop it when it restates a source line already
 * represented. Several unmatched source testers that the same alias could mean are left as they are; the alias is
 * not added. Sale+tester and distinct quantities are not restatements.
 */
function bindTesterRestatements<T extends KeyedLine>(base: T[], incoming: T[]): T[] {
  if (!base.length) return incoming;
  const taken = new Set<number>();
  const result: T[] = [];
  for (const line of incoming) {
    if (!lineWantsTester(line)) {
      result.push(line);
      continue;
    }
    const matches = base.map((item, index) => ({ item, index })).filter(({ item, index }) => !taken.has(index) && testerRestatementOf(line, item));
    if (matches.length === 1) {
      taken.add(matches[0]!.index);
      result.push(matches[0]!.item);
      continue;
    }
    if (matches.length > 1) {
      const sameKey = matches.find(({ item }) => lineKey(item) === lineKey(line));
      if (sameKey) {
        taken.add(sameKey.index);
        result.push(sameKey.item);
      }
      continue;
    }
    if (base.some((item, index) => taken.has(index) && testerRestatementOf(line, item))) continue;
    result.push(line);
  }
  return result;
}

function priorProductId(base: OrderDraft['lines'], incoming: Pick<LinePatch, 'ref' | 'query' | 'quantity' | 'tester'>, index?: number) {
  if (incoming.ref) {
    const byRef = base.find(line => line.ref === incoming.ref);
    if (byRef) return byRef.productId;
  }
  const byKey = base.find(line => lineKey(line) === lineKey(incoming));
  if (byKey) return byKey.productId;
  if (index !== undefined && base[index] && lineKey(base[index]!) === lineKey(incoming)) return base[index]!.productId;
  return undefined;
}

/** Model productIds are proposals. Keep only an id already stored on this request's matching line. */
function dropFabricatedProductId<T extends { productId?: string }>(line: T, prior?: string): T {
  if (!line.productId || line.productId === prior) return line;
  const { productId: _drop, ...rest } = line;
  return rest as T;
}

function restatesExisting(existing: KeyedLine[], line: KeyedLine) {
  const matches = existing.filter(item => testerRestatementOf(line, item));
  return matches.length === 1 || (matches.length > 1 && matches.every(item => lineKey(item) !== lineKey(line)));
}

function applyIncomingLines(base: OrderDraft['lines'], incoming: LinePatch[]): OrderDraft['lines'] {
  if (!incoming.length) return ensureLineRefs(base);
  const hasRefOp = incoming.some(line => line.ref || line.op);
  if (!hasRefOp) {
    if (base.length && sameLines(base, incoming)) return ensureLineRefs(base);
    const next = uniqueByLineKey(incoming.map(({ op: _op, ...line }, index) => dropFabricatedProductId(line, priorProductId(base, line, index))));
    return ensureLineRefs(bindTesterRestatements(base, next));
  }
  const byRef = new Map(base.filter(line => line.ref).map(line => [line.ref!, { ...line }]));
  const unused = base.filter(line => !line.ref || !incoming.some(patch => patch.ref === line.ref));
  const next: OrderDraft['lines'] = [];
  const hasKey = (line: { query: string; quantity?: number; tester?: boolean }) =>
    [...next, ...unused].some(existing => lineKey(existing) === lineKey(line));
  for (const patch of incoming) {
    const { op, ...rest } = patch;
    if (op === 'delete') {
      if (patch.ref) byRef.delete(patch.ref);
      continue;
    }
    const current = patch.ref ? byRef.get(patch.ref) : undefined;
    if (op === 'replace' || !current) {
      const incomingLine = dropFabricatedProductId(rest, current?.productId ?? priorProductId(base, rest));
      if (!current && (hasKey(incomingLine) || restatesExisting([...next, ...unused], incomingLine))) {
        if (patch.ref) byRef.delete(patch.ref);
        continue;
      }
      next.push(incomingLine);
      if (patch.ref) byRef.delete(patch.ref);
      continue;
    }
    const queryChanged = rest.query !== current.query || rest.tester !== current.tester;
    next.push({
      ...current,
      ...rest,
      productId: queryChanged ? undefined : current.productId,
    });
    byRef.delete(patch.ref!);
  }
  if (!incoming.some(line => line.op === 'replace' && !line.ref) && unused.length) {
    // Patch edits keep unmatched existing lines (omission is not delete).
    next.push(...unused.filter(line => !next.some(kept => kept.ref && kept.ref === line.ref)));
  }
  return ensureLineRefs(uniqueByLineKey(next));
}

export type MergeInput = {
  base?: OrderDraft;
  incoming: OrderDraft;
  incomingLines?: LinePatch[];
  attachmentLines?: ReadingLine[];
  operatorWords: string;
  turnWords?: string;
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
  const headerCustomer = /^\s*(?:header:\s*)?customer\s*[:|-]\s*(.+)$/im.exec(input.attachmentText ?? '')?.[1]?.trim() ?? '';
  const askedCreate = operatorAskedToCreateCustomer(input.operatorWords);
  const keepIncomingCustomer = !input.isNewRequest
    || customerNamedInRequest(named, input.operatorWords, input.attachmentText)
    || (askedCreate && !!incoming.newClient);
  const clientQuery = keepIncomingCustomer && incoming.clientQuery.trim()
    ? incoming.clientQuery
    : (start.clientQuery.trim() ? start.clientQuery : (headerCustomer || (!askedCreate ? incoming.newClient?.name?.trim() ?? '' : '')));
  const newClient = keepIncomingCustomer && incoming.newClient && (askedCreate || !input.isNewRequest)
    ? incoming.newClient
    : (!input.isNewRequest ? start.newClient : undefined);
  const clientId = start.clientId;

  const stated = statedShipping(input.operatorWords, input.turnWords);
  const shippingPrice = stated !== undefined
    ? stated
    : !input.isNewRequest && incoming.shippingPrice !== undefined ? incoming.shippingPrice
    : input.isNewRequest ? undefined : start.shippingPrice;

  const labelled = statedNote(input.turnWords ?? '') ?? statedNote(input.operatorWords);
  const fromModel = incoming.notes.trim() ? (statedNote(incoming.notes) ?? incoming.notes.trim()) : '';
  const notes = labelled ?? (fromModel || start.notes);
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
    if (!start.clientQuery.trim()) {
      draft.clientQuery = headerCustomer || (!askedCreate ? incoming.newClient?.name?.trim() ?? '' : '');
    }
    if (!start.newClient) delete draft.newClient;
  }
  if (incoming.clientId && incoming.clientId === start.clientId) draft.clientId = start.clientId;
  return draft;
}
