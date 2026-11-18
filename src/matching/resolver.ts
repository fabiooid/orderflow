import { createHash } from 'node:crypto';
import { withCompleteClientSearch } from './client-search.js';
import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import type { OrderConnector } from '../connector/contract.js';
import {
  clientPickLabel, correspondingTesters, explicitLineSizes, isTester, lineWantsTester, matchClients,
  namedAlternatives, nameInText, normalize, productCodesIn, productIdentitySizes, relatedProducts,
  sameClientIds, searchClients, testerQuery,
} from '../domain/matching.js';
import { draftSchema, type Client, type Product, type Issue, type OrderDraft } from '../domain/types.js';
import { productCandidates, clientCandidates } from './candidates.js';
import { loadMatchingConfig, type MatchingConfig } from './config.js';
import type { Candidate, SelectionRequest, SelectionResult } from './types.js';

export const confirmedChoiceSchema = z.object({
  field: z.string(), id: z.string().min(1), queryHash: z.string(), identityHash: z.string(),
  ref: z.string().min(1).max(64).optional(),
});
export type ConfirmedChoice = z.infer<typeof confirmedChoiceSchema>;
export const searchEvidenceSchema = z.object({
  kind: z.enum(['product', 'client']), query: z.string(), ids: z.array(z.string().min(1)).max(30),
});
export type SearchEvidence = z.infer<typeof searchEvidenceSchema>;
export const pendingQuestionSchema = z.object({
  field: z.string(), ids: z.array(z.string().min(1)).max(10), revision: z.number().int().nonnegative(),
  named: z.string().max(200).optional(),
});
export type PendingQuestion = z.infer<typeof pendingQuestionSchema>;
export const resolutionContextSchema = z.object({
  orderId: z.string(), revision: z.number().int().nonnegative().default(0),
  operatorText: z.string().max(12000),
  /** Operator-typed/said words for this whole request. Empty in older callers: operatorText is then the evidence. */
  operatorWords: z.string().max(12000).optional(),
  /** Attachment facts for this request. */
  attachmentText: z.string().max(12000).optional(),
  /** This message only, used to bind yes/ok to the active question. */
  turnWords: z.string().max(4000).optional(),
  confirmedChoices: z.array(confirmedChoiceSchema).max(101).optional(),
  pendingQuestion: pendingQuestionSchema.optional(),
  searchEvidence: z.array(searchEvidenceSchema).max(20).optional(),
  /** A candidate the operator picked with a button in this turn. */
  choice: z.object({ field: z.string().regex(/^(?:client|lines\.\d+)$/), id: z.string().min(1) }).optional(),
});
export type ResolutionContext = z.infer<typeof resolutionContextSchema>;
export const decisionSchema = z.object({
  field: z.string(), status: z.enum(['matched', 'ambiguous', 'no-match', 'unavailable']),
  selectedId: z.string().min(1).optional(), queryHash: z.string().optional(), identityHash: z.string().optional(), inputHash: z.string(), candidateHash: z.string(), snapshotHash: z.string().optional(),
  source: z.enum(['exact', 'operator', 'jev']), model: z.string().optional(), confidence: z.number().optional(),
  strategy: z.string().optional(), requestHash: z.string().optional(), promptVersion: z.string().optional(), reason: z.string().optional(),
  searchGroups: z.array(z.object({ candidateCount: z.number().optional(), candidateHash: z.string().optional(), reason: z.string().optional(), status: z.enum(['matched', 'ambiguous', 'no-match', 'unavailable']), selectedId: z.string().min(1).optional(), evidence: z.unknown() })).optional(),
  probabilities: z.record(z.string(), z.number()).optional(), elapsedMs: z.number().optional(),
});
export type Decision = z.infer<typeof decisionSchema>;
export const confirmedChoices = (decisions: Decision[], draft?: OrderDraft) => decisions.flatMap(d => {
  if ((d.source !== 'operator' && d.source !== 'exact') || d.status !== 'matched' || !d.selectedId || !d.queryHash || !d.identityHash) return [];
  const index = /^lines\.(\d+)$/.exec(d.field);
  const ref = index ? draft?.lines[Number(index[1])]?.ref : undefined;
  return [{ field: d.field, id: d.selectedId, queryHash: d.queryHash, identityHash: d.identityHash, ...(ref ? { ref } : {}) }];
});
export type AliasData = { aliases: { phrase: string; productId: string }[]; clientAliases: { phrase: string; clientId: string }[] };
export type SelectMany = (inputs: SelectionRequest[]) => Promise<SelectionResult[]>;
export type Resolution = { draft: OrderDraft; issues: Issue[]; decisions: Decision[] };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snapshotHash = (candidates: Candidate[]) => hash([...candidates].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const identityHash = (candidate: Candidate) => { const { aliases: _aliases, ...identity } = candidate; return hash(identity); };
const has = (text: string, value: string) => !!normalize(value) && ` ${normalize(text)} `.includes(` ${normalize(value)} `);
const spoken = (context: ResolutionContext) => context.operatorWords?.trim() || context.operatorText;
const requestEvidence = (context: ResolutionContext) => [context.operatorWords, context.attachmentText].filter(text => text?.trim()).join('\n') || context.operatorText;
const AFFIRM = /^(sì|si|yes|ok|okay|va bene|confermo|quello|quella)\b/i;
const FILE_CONSENT = /\b(prepara|prepare|crea(?:re)?(?:\s+un)?\s+ordine|create(?:\s+an?)?\s+order|importa|allegat|file|excel|xlsx|this file)\b/i;

function confirmsPendingCustomer(turnWords: string | undefined, pending?: z.infer<typeof pendingQuestionSchema>) {
  if (!pending || pending.field !== 'client' || pending.ids.length !== 1) return false;
  const trimmed = turnWords?.trim() ?? '';
  if (!AFFIRM.test(trimmed) || trimmed.length >= 80) return false;
  return !FILE_CONSENT.test(trimmed);
}

type Pending = {
  field: string; kind: SelectionRequest['kind']; query: string; candidates: Candidate[];
  exact?: Candidate; operator?: boolean; forced?: 'ambiguous' | 'no-match' | 'unavailable';
  reason?: string; keepOnNoMatch?: Candidate[];
};

/** Fetch complete records and apply only identities the current request actually supports. */
export function createIdentityResolver(app: AppConfig, connector: OrderConnector, options: {
  config?: MatchingConfig; selectMany?: SelectMany; aliases?: () => Promise<AliasData>;
} = {}) {
  const config = options.config ?? loadMatchingConfig();
  if (config.mode !== 'off' && !options.selectMany) throw new Error('Pass selectMany when matching mode is not off.');
  const selectMany = options.selectMany ? withCompleteClientSearch(options.selectMany, config.largeClientSearch) : async () => [];

  async function resolve(input: OrderDraft, context: ResolutionContext): Promise<Resolution> {
    const original = draftSchema.parse(input);
    resolutionContextSchema.parse(context);
    const choice = context.choice;
    const draft = structuredClone(original), issues: Issue[] = [], decisions: Decision[] = [];
    const named = draft.clientQuery, proposed = draft.newClient?.name;
    if (named && proposed && !has(named, proposed) && !has(proposed, named) && has(spoken(context), named)) delete draft.newClient;
    let products, clients, aliases: AliasData;
    try {
      [products, clients, aliases] = await Promise.all([connector.listProducts(), connector.listClients(), options.aliases?.() ?? { aliases: [], clientAliases: [] }]);
    } catch {
      return { draft: original, decisions: ['client', ...original.lines.map((_, i) => `lines.${i}`)].map(field => ({
        field, status: 'unavailable' as const, source: 'jev' as const, inputHash: hash(context), candidateHash: hash([]), reason: 'record-lookup-unavailable',
      })), issues: config.mode === 'shadow' ? [] : [{ field: 'client', message: 'Identity lookup unavailable. Retry before preparing this order.', matchingStatus: 'unavailable' }] };
    }
    const pending: Pending[] = [];
    const clientQuery = draft.clientQuery || draft.newClient?.name || '';
    const listed = clients.filter((c): c is Client & { id: string } => !!c.id);
    const vat = draft.newClient?.vatNumber ?? /(?:VAT|partita IVA|P\.? IVA)\s*[:#]?\s*([A-Z0-9]{6,})/i.exec(clientQuery)?.[1];
    const country = draft.newClient?.country;
    const namedCities = [...new Set(listed.map(c => c.city).filter((city): city is string => !!city && has(clientQuery, city)))];
    const eligibleRecords = listed.filter(c => (!namedCities.length || namedCities.includes(c.city)) && (!vat || normalize(c.vatNumber ?? '') === normalize(vat)) && (!country || c.country === country));
    const allWord = clientQuery ? matchClients(clientQuery, eligibleRecords) : [];
    const related = clientQuery ? searchClients(clientQuery, eligibleRecords) : [];
    const searchedClients = context.searchEvidence?.filter(s => s.kind === 'client') ?? [];
    const searchHits = listed.filter(c => searchedClients.some(s => s.ids.includes(c.id)));
    const lexical = related.length ? related : allWord;
    const seenClients = new Set(lexical.map(c => c.id));
    const combined = [...lexical, ...searchHits.filter(c => !seenClients.has(c.id))];
    const ca = aliases.clientAliases.filter(a => normalize(a.phrase) === normalize(clientQuery));
    const addAliases = (c: Candidate, values: string[]) => {
      const merged = [...new Set([...(c.aliases ?? []), ...values].filter(Boolean))];
      return { ...c, ...(merged.length ? { aliases: merged } : {}) };
    };
    const evidence = requestEvidence(context);
    const confirmClient = confirmsPendingCustomer(context.turnWords, context.pendingQuestion)
      ? listed.find(c => c.id === context.pendingQuestion?.ids[0]) : undefined;
    const narrowed = choice?.field === 'client' ? listed.filter(c => c.id === choice.id)
      : confirmClient ? [confirmClient]
      : combined;
    const clientSet = clientCandidates(narrowed).map(c => addAliases(c, ca.filter(a => a.clientId === c.id).map(a => a.phrase)));
    const confirmedClient = context.confirmedChoices?.find(c => c.field === 'client' && c.queryHash === hash(normalize(clientQuery)) && clientSet.some(record => record.id === c.id && identityHash(record) === c.identityHash));
    const vatTyped = !!(vat && has(evidence, vat));
    const vatMatches = vatTyped ? clientSet.filter(c => normalize(c.vatNumber ?? '') === normalize(vat)) : [];
    const exactClients = clientSet.filter(c => choice?.field === 'client' ? c.id === choice.id
      : confirmClient ? c.id === confirmClient.id
      : confirmedClient ? c.id === confirmedClient.id
      : [c.name, c.vatNumber ?? ''].some(v => normalize(v) === normalize(clientQuery) && has(evidence, v))
        || (vatMatches.length === 1 && c.id === vatMatches[0]!.id));
    const siblingAsk = choice?.field !== 'client' && !confirmedClient && !confirmClient && exactClients.length !== 1
      && (allWord.length > 1 || (allWord.length === 0 && related.length > 0) || (related.length > 0 && !sameClientIds(allWord, related)));
    const heldClient = original.clientId
      ? clientCandidates(listed.filter(c => c.id === original.clientId && (!clientQuery || matchClients(clientQuery, [c]).length === 1)))[0]
      : undefined;
    const clientExact = (exactClients.length === 1 && (choice?.field === 'client' || confirmedClient || confirmClient || new Set(ca.map(a => a.clientId)).size <= 1) ? exactClients[0] : undefined)
      ?? heldClient;
    const clientForced: Pending['forced'] = choice?.field === 'client' && !clientSet.length ? 'no-match'
      : !clientQuery && choice?.field !== 'client' && !confirmClient ? 'no-match'
      : clientExact ? undefined
      : siblingAsk || new Set(ca.map(a => a.clientId)).size > 1 || clientSet.length > 0 ? 'ambiguous'
      : clientQuery ? 'no-match' : 'no-match';
    pending.push({ field: 'client', kind: 'client', query: clientQuery, candidates: clientSet,
      operator: choice?.field === 'client' || !!confirmedClient || !!confirmClient,
      exact: clientExact,
      reason: clientExact ? (choice?.field === 'client' || confirmedClient || confirmClient ? 'operator-pick' : 'exact-customer')
        : clientForced === 'ambiguous' ? 'unconfirmed-candidate' : 'missing-customer',
      ...(clientForced ? { forced: clientForced } : {}),
      keepOnNoMatch: clientSet });

    const catalogue = products.filter(p => p.id !== app.invoicing.shippingProductId);
    for (const [index, line] of draft.lines.entries()) {
      const wantsTester = lineWantsTester(line);
      const incoming = testerQuery(line);
      const all = products.filter(p => p.id !== app.invoicing.shippingProductId && (p.netPrice > 0 || isTester(p)));
      const confirmed = context.confirmedChoices?.find(c => {
        const queryOk = c.queryHash === hash(normalize(incoming));
        const identityOk = productCandidates(all).some(record => record.id === c.id && identityHash(record) === c.identityHash);
        if (!queryOk || !identityOk) return false;
        if (c.ref && line.ref) return c.ref === line.ref;
        return c.field === `lines.${index}`;
      });
      const picked = all.find(p => p.id === (choice?.field === `lines.${index}` ? choice.id : confirmed?.id));
      const chosen = picked && (!wantsTester || isTester(picked)) ? picked : undefined;
      if (chosen) {
        if (line.productId !== chosen.id && line.documentPrice) line.documentPrice.decision = 'pending';
        line.query = chosen.name;
      }
      const query = testerQuery(line);
      const coded = productCodesIn(query, all);
      const uniqueCode = coded.length === 1 ? coded[0] : undefined;
      const codeSupported = !!(uniqueCode?.code && nameInText(evidence, uniqueCode.code));
      const equalNames = all.filter(p => has(evidence, p.name) && normalize(p.name) === normalize(query));
      const equalCodes = all.filter(p => has(evidence, p.code) && normalize(p.code) === normalize(query));
      const containedNames = all.filter(p => has(evidence, p.name) && has(query, p.name));
      const namedExact = equalNames.length ? equalNames : equalCodes.length ? equalCodes : containedNames;
      const testers = wantsTester ? correspondingTesters(query, all) : [];
      const uniqueTester = testers.length === 1 ? testers[0] : undefined;
      const extraSizes = explicitLineSizes(query, spoken(context), context.attachmentText ?? '');
      const variantConflict = !!(uniqueCode && codeSupported && extraSizes.some(size => !productIdentitySizes(uniqueCode).includes(size)));
      const stored = original.lines[index]?.productId ? all.find(p => p.id === original.lines[index]!.productId) : undefined;
      const storedFitsQuery = !!(stored && [stored.code, stored.name].some(value => normalize(value) === normalize(query) || has(query, value) || nameInText(query, stored.code)));
      const heldProduct = stored && storedFitsQuery && (!wantsTester || isTester(stored)) && (wantsTester || !isTester(stored) || nameInText(query, stored.code))
        ? stored : undefined;
      const exactIdentity = chosen
        ?? (wantsTester ? (uniqueTester && isTester(uniqueTester) ? uniqueTester : undefined) : undefined)
        ?? (!wantsTester && uniqueCode && codeSupported && !variantConflict ? uniqueCode : undefined)
        ?? (!wantsTester && namedExact.length === 1 ? namedExact[0] : undefined)
        ?? heldProduct;
      const exactCodes = exactIdentity ? [exactIdentity] : wantsTester ? namedExact.filter(isTester) : namedExact;
      const searchedIds = new Set((context.searchEvidence ?? []).filter(s => s.kind === 'product').flatMap(s => s.ids));
      const eligible = wantsTester
        ? testers
        : all.filter(p => (!coded.length || coded.some(c => c.id === p.id) || searchedIds.has(p.id))
          && (isTester(p) === wantsTester || exactCodes.some(e => e.id === p.id))
          && (variantConflict || extraSizes.every(size => productIdentitySizes(p).includes(size))));
      const constrained = variantConflict
        ? [...new Map([uniqueCode, ...all.filter(p => extraSizes.every(size => productIdentitySizes(p).includes(size)) && isTester(p) === wantsTester)].filter((p): p is Product => !!p).map(p => [p.id, p])).values()]
        : eligible;
      const pa = aliases.aliases.filter(a => normalize(a.phrase) === normalize(line.query));
      let candidates = productCandidates(constrained.length ? constrained : eligible).map(c => addAliases(c, pa.filter(a => a.productId === c.id).map(a => a.phrase)));
      if (!candidates.length && !wantsTester) {
        const named = namedAlternatives(query, catalogue);
        const related = named.length ? named : relatedProducts(query, catalogue);
        candidates = productCandidates(related).map(c => addAliases(c, []));
      }
      const uniqueExact = exactCodes.length === 1 ? candidates.find(c => c.id === exactCodes[0]!.id) ?? productCandidates(exactCodes)[0] : undefined;
      pending.push({ field: `lines.${index}`, kind: 'product', query, candidates,
        operator: !!chosen,
        exact: uniqueExact && !variantConflict ? uniqueExact : undefined,
        reason: chosen ? 'operator-pick' : uniqueTester && exactIdentity === uniqueTester ? 'unique-tester'
          : variantConflict ? 'variant-conflict'
          : uniqueCode && codeSupported ? 'unique-sku'
          : namedExact.length === 1 ? 'exact-name' : undefined,
        keepOnNoMatch: candidates,
        ...(choice?.field === `lines.${index}` && !chosen && !(wantsTester && testers.length === 1) ? { forced: 'no-match' as const, reason: 'stale-pick' } : {}),
        ...(!chosen && new Set(pa.map(a => a.productId)).size > 1 ? { forced: 'ambiguous' as const, reason: 'conflicting-alias' } : {}),
        ...(wantsTester && !chosen && testers.length !== 1 ? { forced: testers.length ? 'ambiguous' as const : 'no-match' as const, reason: testers.length ? 'ambiguous-tester' : 'missing-tester' } : {}),
        ...(variantConflict && !chosen ? { forced: 'ambiguous' as const, reason: 'variant-conflict' } : {}) });
    }

    const requests: SelectionRequest[] = [], requested: Pending[] = [];
    for (const item of pending) {
      const largeClient = item.kind === 'client' && config.largeClientSearch && listed.length > 253 && !item.exact;
      if (largeClient) {
        item.candidates = clientCandidates(eligibleRecords.length ? eligibleRecords : listed);
        item.forced = undefined;
      }
      if (item.exact || (!largeClient && (item.forced || config.mode === 'off'))) continue;
      if (!largeClient && (item.candidates.length < 2 || item.candidates.length > 253)) continue;
      if (largeClient && item.candidates.length < 2) continue;
      requested.push(item);
      requests.push({ kind: item.kind, query: item.query || '(customer identity missing)', context: context.operatorText,
        candidates: item.candidates, retrieval: { complete: true, furtherSearchPossible: false } });
    }
    let results: SelectionResult[] = [];
    if (config.mode !== 'off' && requests.length) {
      try { results = await selectMany(requests); } catch { results = []; }
    }

    for (const item of pending) {
      const result = results[requested.indexOf(item)];
      const oversized = !item.exact && !item.forced && item.candidates.length > 253 && !(item.kind === 'client' && config.largeClientSearch);
      let status: Decision['status'] = oversized ? 'unavailable' : item.forced ?? (item.exact ? 'matched' : item.candidates.length ? 'ambiguous' : 'no-match');
      let selectedId = item.exact?.id;
      let reason = item.reason ?? (oversized ? 'candidate-set-too-large' : status === 'matched' ? 'exact' : item.candidates.length ? 'unconfirmed-candidate' : 'no-candidate');
      if (result && !item.exact && !item.forced && !oversized) {
        if (config.mode === 'shadow') {
          status = result.status;
          selectedId = result.selectedId;
          reason = result.status === 'matched' ? 'matcher-proposal' : result.status;
        } else if (result.status === 'matched' && result.selectedId && item.candidates.some(c => c.id === result.selectedId)) {
          const preferred = item.candidates.filter(c => c.id === result.selectedId);
          const rest = item.candidates.length > 253
            ? (item.keepOnNoMatch ?? []).filter(c => c.id !== result.selectedId)
            : item.candidates.filter(c => c.id !== result.selectedId);
          item.candidates = [...preferred, ...rest];
          reason = 'matcher-proposal';
          status = 'ambiguous';
        } else if (result.status === 'ambiguous' && result.clarificationIds?.length) {
          const offered = result.clarificationIds.flatMap(id => item.candidates.filter(c => c.id === id));
          if (offered.length) item.candidates = offered;
          reason = 'matcher-ranked';
          status = 'ambiguous';
        } else if (result.status === 'no-match') {
          if (item.keepOnNoMatch?.length) {
            item.candidates = item.keepOnNoMatch;
            status = 'ambiguous';
            reason = 'matcher-no-match-kept-candidates';
          } else if (item.candidates.length > 253) {
            item.candidates = [];
            status = 'no-match';
            reason = 'matcher-no-match';
          } else if (item.candidates.length) {
            status = 'ambiguous';
            reason = 'matcher-no-match-kept-candidates';
          } else {
            status = 'no-match';
            reason = 'matcher-no-match';
          }
        } else if (result.status === 'unavailable') {
          status = item.candidates.length ? 'ambiguous' : 'unavailable';
          reason = 'matcher-unavailable';
        }
      }
      if (status === 'matched' && selectedId && !item.candidates.some(c => c.id === selectedId) && item.exact) {
        item.candidates = [item.exact, ...item.candidates];
      }
      if (status === 'matched' && selectedId && !item.candidates.some(c => c.id === selectedId) && !item.exact) status = 'unavailable';
      if (item.field === 'client' && choice?.field === 'client' && status === 'matched') { delete draft.newClient; draft.clientQuery = item.exact!.name; }
      if (item.field === 'client' && draft.newClient && status === 'matched') { status = 'ambiguous'; selectedId = undefined; reason = 'new-client-duplicate-check'; }
      if (item.field === 'client' && draft.newClient && status === 'no-match') {
        // A complete check found nobody: creating a new customer may proceed.
      }
      if (item.candidates.length > 253 && status !== 'matched') {
        const known = item.keepOnNoMatch ?? [];
        const proposed = result?.selectedId ? item.candidates.filter(c => c.id === result.selectedId) : [];
        item.candidates = [...proposed, ...known.filter(c => c.id !== result?.selectedId)].slice(0, 10);
        if (!item.candidates.length) status = status === 'no-match' || result?.status === 'no-match' ? 'no-match' : 'unavailable';
      }
      decisions.push({ field: item.field, status, ...(status === 'matched' && selectedId ? { selectedId } : result?.selectedId && item.candidates.some(c => c.id === result.selectedId) ? { selectedId: result.selectedId } : {}),
        inputHash: hash({ ...context, query: item.query }), candidateHash: hash(item.candidates),
        snapshotHash: snapshotHash(item.kind === 'client' ? clientCandidates(clients) : productCandidates(products)),
        queryHash: hash(normalize(item.field === 'client' ? draft.clientQuery : item.query)), identityHash: status === 'matched' && selectedId ? identityHash(item.candidates.find(c => c.id === selectedId) ?? item.exact!) : undefined,
        source: item.operator && item.exact ? 'operator' : item.exact ? 'exact' : 'jev',
        ...(result?.selectedId && status !== 'matched' ? {} : {}),
        model: result?.evidence.model,
        confidence: result?.evidence.confidence, requestHash: result?.evidence.requestHash, promptVersion: result?.evidence.promptVersion,
        strategy: result?.evidence.strategy, searchGroups: result?.evidence.groups, probabilities: result?.evidence.probabilities, elapsedMs: result?.evidence.elapsedMs, reason });
      if (config.mode === 'shadow') continue;
      if (item.field === 'client') delete draft.clientId;
      else delete draft.lines[Number(item.field.split('.')[1])]!.productId;
      if (status === 'matched' && selectedId) {
        if (item.field === 'client') draft.clientId = selectedId;
        else {
          const line = draft.lines[Number(item.field.split('.')[1])]!;
          if (original.lines[Number(item.field.split('.')[1])]!.productId !== selectedId && line.documentPrice) line.documentPrice.decision = 'pending';
          line.productId = selectedId;
        }
      } else if (!(item.field === 'client' && draft.newClient && status === 'no-match')) {
        const offered = item.candidates;
        const missingCombination = item.kind === 'product' && status !== 'matched' && !item.exact && offered.length > 0
          && item.reason !== 'variant-conflict' && reason !== 'matcher-no-match-kept-candidates' && extraMessage(item, catalogue);
        issues.push({ field: item.field, matchingStatus: status === 'unavailable' ? 'unavailable' : status === 'no-match' ? 'no-match' : 'ambiguous',
          message: status === 'unavailable' ? 'Identity matching unavailable or candidate set too large. Retry or specify an exact code.'
            : item.reason === 'variant-conflict' ? 'The requested size or variant conflicts with this catalogue code. Choose the intended product. No record has been selected.'
            : missingCombination ? 'This combination is not in the catalogue. Related products that match part of the request are listed; none of them is the requested item.'
            : status === 'no-match' ? (item.kind === 'product' ? 'No catalogue product matches these words. No record has been selected.' : 'No existing record matches. Check the spelling, or provide details to create a new record. No record has been selected.')
            : item.kind === 'client' ? 'Clarify the exact identity; pick the named account, or type the legal name or VAT. No record has been selected.'
            : 'Clarify the exact identity. No record has been selected.',
          candidates: offered.slice(0, 10).map(c => ({ id: c.id, label: clientPickLabel(c) })) });
      }
    }
    return { draft: config.mode === 'shadow' ? original : draft, issues, decisions };
  }
  return { mode: config.mode, policy: `identities-v3:${config.mode}:${config.model}:large-clients=${config.largeClientSearch}`, resolve };
}
export type IdentityResolver = ReturnType<typeof createIdentityResolver>;

function extraMessage(item: Pending, catalogue: Product[]) {
  if (item.kind !== 'product') return false;
  const matches = namedAlternatives(item.query, catalogue);
  return !matches.length && relatedProducts(item.query, catalogue).some(p => item.candidates.some(c => c.id === p.id));
}

/** Compare the fresh records used by preparation with the identities actually judged. Price-only changes are allowed. */
export function changedIdentities(decisions: Decision[], products: Product[], clients: Client[]): Issue[] {
  return decisions.flatMap(d => {
    if (d.status !== 'matched') return [];
    const records = d.field === 'client' ? clientCandidates(clients) : productCandidates(products);
    const record = records.find(r => r.id === d.selectedId);
    return record && identityHash(record) === d.identityHash && (d.source === 'operator' || snapshotHash(records) === d.snapshotHash) ? [] : [{ field: d.field, matchingStatus: 'unavailable' as const, message: 'Catalogue identity changed during preparation. Retry to resolve the current record.' }];
  });
}
