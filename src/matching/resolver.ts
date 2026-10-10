import { createHash } from 'node:crypto';
import { withCompleteClientSearch } from './client-search.js';
import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import type { OrderConnector } from '../connector/contract.js';
import { asksForTester, isTester, normalize } from '../domain/matching.js';
import { draftSchema, type Client, type Product, type Issue, type OrderDraft } from '../domain/types.js';
import { productCandidates, clientCandidates } from './candidates.js';
import { loadMatchingConfig, type MatchingConfig } from './config.js';
import { createJevBatchSelector, sdkTransport } from './jev-client.js';
import type { Candidate, SelectionRequest, SelectionResult } from './types.js';

export const confirmedChoiceSchema = z.object({ field: z.string(), id: z.string().min(1), queryHash: z.string(), identityHash: z.string() });
export type ConfirmedChoice = z.infer<typeof confirmedChoiceSchema>;
export const resolutionContextSchema = z.object({
  orderId: z.string(), revision: z.number().int().nonnegative().default(0),
  operatorText: z.string().max(12000),
  confirmedChoices: z.array(confirmedChoiceSchema).max(101).optional(),
  /** A candidate the operator picked with a button in this turn: the only way an ID enters from outside the resolver. */
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
export const confirmedChoices = (decisions: Decision[]) => decisions.flatMap(d => d.source === 'operator' && d.status === 'matched' && d.selectedId && d.queryHash && d.identityHash ? [{ field: d.field, id: d.selectedId, queryHash: d.queryHash, identityHash: d.identityHash }] : []);
export type AliasData = { aliases: { phrase: string; productId: string }[]; clientAliases: { phrase: string; clientId: string }[] };
export type SelectMany = (inputs: SelectionRequest[]) => Promise<SelectionResult[]>;
export type Resolution = { draft: OrderDraft; issues: Issue[]; decisions: Decision[] };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snapshotHash = (candidates: Candidate[]) => hash([...candidates].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const identityHash = (candidate: Candidate) => { const { aliases: _aliases, ...identity } = candidate; return hash(identity); };
const has = (text: string, value: string) => !!normalize(value) && ` ${normalize(text)} `.includes(` ${normalize(value)} `);
const units: Record<string, number> = { ml: 1, cl: 10, l: 1000, lt: 1000, litro: 1000, litri: 1000, g: 1, gr: 1, kg: 1000, mm: 1, cm: 10 };
function sizes(text: string) {
  // Catalogue names write litres as "5lt"; documents as "5 L" or "5 litri".
  return [...text.toLowerCase().matchAll(/(\d+(?:[.,]\d+)?)\s*(ml|cl|kg|gr|cm|mm|litri|litro|lt|l|g)\b/g)]
    .map(([, n, unit]) => `${['ml', 'cl', 'l', 'lt', 'litro', 'litri'].includes(unit!) ? 'volume' : ['mm', 'cm'].includes(unit!) ? 'length' : 'weight'}:${Number(n!.replace(',', '.')) * units[unit!]!}`);
}

/** Fetch complete records, judge identities, and apply only validated IDs. No writes or model-authored evidence. */
export function createIdentityResolver(app: AppConfig, connector: OrderConnector, options: {
  config?: MatchingConfig; selectMany?: SelectMany; aliases?: () => Promise<AliasData>;
} = {}) {
  const config = options.config ?? loadMatchingConfig();
  const selectMany = withCompleteClientSearch(options.selectMany ?? createJevBatchSelector(config,
    config.mode === 'off' ? undefined : sdkTransport(config, process.env.TYPESAFE_API_KEY ?? '')), config.largeClientSearch);

  async function resolve(input: OrderDraft, context: ResolutionContext): Promise<Resolution> {
    const original = draftSchema.parse(input);
    if (config.mode === 'off') return { draft: original, issues: [], decisions: [] };
    resolutionContextSchema.parse(context);
    const choice = context.choice;
    const draft = structuredClone(original), issues: Issue[] = [], decisions: Decision[] = [];
    // A named customer that is a different company from the new-client details (often billing details read from a
    // document) replaces them, like a product correction. Otherwise their VAT number would confine the search to the
    // document's company, and a no-match could create that company instead.
    const named = draft.clientQuery, proposed = draft.newClient?.name;
    if (named && proposed && !has(named, proposed) && !has(proposed, named) && has(context.operatorText, named)) delete draft.newClient;
    let products, clients, aliases: AliasData;
    try {
      [products, clients, aliases] = await Promise.all([connector.listProducts(), connector.listClients(), options.aliases?.() ?? { aliases: [], clientAliases: [] }]);
    } catch {
      return { draft: original, decisions: ['client', ...original.lines.map((_, i) => `lines.${i}`)].map(field => ({
        field, status: 'unavailable' as const, source: 'jev' as const, inputHash: hash(context), candidateHash: hash([]), reason: 'record-lookup-unavailable',
      })), issues: config.mode === 'on' ? [{ field: 'client', message: 'Identity lookup unavailable. Retry before preparing this order.', matchingStatus: 'unavailable' }] : [] };
    }
    type Pending = { field: string; kind: SelectionRequest['kind']; query: string; candidates: Candidate[]; exact?: Candidate; operator?: boolean; forced?: 'ambiguous' | 'no-match' };
    const pending: Pending[] = [];
    const clientQuery = draft.clientQuery || draft.newClient?.name || '';
    const clientOptions = clientCandidates(clients);
    const vat = draft.newClient?.vatNumber ?? /(?:VAT|partita IVA|P\.? IVA)\s*[:#]?\s*([A-Z0-9]{6,})/i.exec(clientQuery)?.[1];
    const country = draft.newClient?.country;
    const namedCities = [...new Set(clientOptions.map(c => c.city).filter((city): city is string => !!city && has(clientQuery, city)))];
    const eligibleClients = clientOptions.filter(c => (!namedCities.length || namedCities.includes(c.city ?? '')) && (!vat || normalize(c.vatNumber ?? '') === normalize(vat)) && (!country || c.country === country));
    const ca = aliases.clientAliases.filter(a => normalize(a.phrase) === normalize(clientQuery));
    const addAliases = (c: Candidate, values: string[]) => ({ ...c, ...(values.length ? { aliases: values } : {}) });
    const clientSet = (choice?.field === 'client' ? clientOptions.filter(c => c.id === choice.id) : eligibleClients).map(c => addAliases(c, ca.filter(a => a.clientId === c.id).map(a => a.phrase)));
    const confirmedClient = context.confirmedChoices?.find(c => c.field === 'client' && c.queryHash === hash(normalize(clientQuery)) && clientSet.some(record => record.id === c.id && identityHash(record) === c.identityHash));
    const exactClients = clientSet.filter(c => choice?.field === 'client' ? c.id === choice.id : confirmedClient ? c.id === confirmedClient.id : [c.name, c.vatNumber ?? ''].some(v => normalize(v) === normalize(clientQuery) && has(context.operatorText, v)));
    pending.push({ field: 'client', kind: 'client', query: clientQuery, candidates: clientSet,
      operator: choice?.field === 'client' || !!confirmedClient,
      exact: exactClients.length === 1 && (choice?.field === 'client' || confirmedClient || new Set(ca.map(a => a.clientId)).size <= 1) ? exactClients[0] : undefined,
      ...(choice?.field === 'client' && !clientSet.length ? { forced: 'no-match' as const } : {}),
      ...(!clientQuery && choice?.field !== 'client' ? { forced: 'no-match' as const } : {}),
      ...(choice?.field !== 'client' && !confirmedClient && new Set(ca.map(a => a.clientId)).size > 1 ? { forced: 'ambiguous' as const } : {}) });
    for (const [index, line] of draft.lines.entries()) {
      const all = products.filter(p => p.id !== app.invoicing.shippingProductId && p.netPrice > 0);
      const confirmed = context.confirmedChoices?.find(c => c.field === `lines.${index}` && c.queryHash === hash(normalize(line.query)) && productCandidates(all).some(record => record.id === c.id && identityHash(record) === c.identityHash));
      const chosen = all.find(p => p.id === (choice?.field === `lines.${index}` ? choice.id : confirmed?.id));
      if (chosen) {
        if (line.productId !== chosen.id && line.documentPrice) line.documentPrice.decision = 'pending';
        line.query = chosen.name;
      }
      const exactCodes = chosen ? [chosen] : all.filter(p => [p.code, p.name].some(value => normalize(value) === normalize(line.query) && has(context.operatorText, value)));
      const requestedSizes = sizes(line.query);
      const codes = all.filter(p => p.code && (normalize(p.code) === normalize(line.query) || (/\d/.test(p.code) || /\b(sku|code|codice)\b/i.test(line.query)) && has(line.query, p.code)));
      const wantsTester = asksForTester(line.query) && !/\b(non|no|not|senza|without)\s+(?:a\s+)?tester/i.test(line.query);
      const eligible = all.filter(p => (!codes.length || codes.some(c => c.id === p.id)) && (isTester(p) === wantsTester || exactCodes.some(e => e.id === p.id)) && requestedSizes.every(size => (sizes(`${p.code} ${p.name}`).length ? sizes(`${p.code} ${p.name}`) : sizes(p.description)).includes(size)));
      const pa = aliases.aliases.filter(a => normalize(a.phrase) === normalize(line.query));
      const candidates = productCandidates(eligible).map(c => addAliases(c, pa.filter(a => a.productId === c.id).map(a => a.phrase)));
      pending.push({ field: `lines.${index}`, kind: 'product', query: line.query, candidates,
        operator: !!chosen,
        exact: exactCodes.length === 1 ? candidates.find(c => c.id === exactCodes[0]!.id) : undefined,
        ...(choice?.field === `lines.${index}` && !chosen ? { forced: 'no-match' as const } : {}),
        ...(!chosen && new Set(pa.map(a => a.productId)).size > 1 ? { forced: 'ambiguous' as const } : {}) });
    }
    const requests: SelectionRequest[] = [], requested: Pending[] = [];
    for (const item of pending) {
      if (item.exact || item.forced) continue;
      requested.push(item);
      requests.push({ kind: item.kind, query: item.query || '(customer identity missing)', context: context.operatorText,
        candidates: item.candidates, retrieval: { complete: true, furtherSearchPossible: false } });
    }
    let results: SelectionResult[];
    try { results = await selectMany(requests); } catch { results = []; }
    for (const item of pending) {
      const result = results[requested.indexOf(item)];
      const selectedId = item.exact?.id ?? result?.selectedId;
      let status: Decision['status'] = item.forced ?? (item.exact ? 'matched' : result?.status ?? 'unavailable');
      if (status === 'matched' && !item.candidates.some(c => c.id === selectedId)) status = 'unavailable';
      // New-customer requests may proceed only after a complete semantic duplicate check reports no match.
      if (item.field === 'client' && choice?.field === 'client' && status === 'matched') { delete draft.newClient; draft.clientQuery = item.exact!.name; }
      if (item.field === 'client' && draft.newClient && status === 'matched') status = 'ambiguous';
      decisions.push({ field: item.field, status, ...(status === 'matched' ? { selectedId } : {}),
        inputHash: hash({ ...context, query: item.query }), candidateHash: hash(item.candidates),
        snapshotHash: snapshotHash(item.kind === 'client' ? clientCandidates(clients) : productCandidates(products)),
        queryHash: hash(normalize(item.field === 'client' ? draft.clientQuery : item.query)), identityHash: status === 'matched' ? identityHash(item.candidates.find(c => c.id === selectedId)!) : undefined,
        source: item.operator && item.exact ? 'operator' : item.exact ? 'exact' : 'jev', model: result?.evidence.model,
        confidence: result?.evidence.confidence, requestHash: result?.evidence.requestHash, promptVersion: result?.evidence.promptVersion,
        strategy: result?.evidence.strategy, searchGroups: result?.evidence.groups, probabilities: result?.evidence.probabilities, elapsedMs: result?.evidence.elapsedMs, reason: result?.reason });
      if (config.mode === 'shadow') continue;
      if (item.field === 'client') delete draft.clientId;
      else delete draft.lines[Number(item.field.split('.')[1])]!.productId;
      if (status === 'matched') {
        if (item.field === 'client') draft.clientId = selectedId;
        else {
          const line = draft.lines[Number(item.field.split('.')[1])]!;
          if (original.lines[Number(item.field.split('.')[1])]!.productId !== selectedId && line.documentPrice) line.documentPrice.decision = 'pending';
          line.productId = selectedId;
        }
      } else if (!(item.field === 'client' && draft.newClient && status === 'no-match')) {
        // A no-match judged every candidate unfit, so none of them is offered as a choice.
        const offered = status === 'no-match' ? [] : result?.clarificationIds ? result.clarificationIds.flatMap(id => item.candidates.filter(c => c.id === id)) : item.candidates;
        issues.push({ field: item.field, matchingStatus: status,
          message: status === 'unavailable' ? 'Identity matching unavailable or candidate set too large. Retry or specify an exact code.'
            : status === 'no-match' ? 'No existing record matches. Check the spelling, or provide details to create a new record. No record has been selected.'
            : 'Clarify the exact identity; provide the customer city, VAT number, or a more specific name. No record has been selected.',
          candidates: offered.slice(0, 10).map(c => ({ id: c.id, label: [c.code, c.name, c.city, c.country, c.vatNumber].filter(Boolean).join(' — ') })) });
      }
    }
    return { draft: config.mode === 'shadow' ? original : draft, issues, decisions };
  }
  return { mode: config.mode, policy: `jev-identities-v2:${config.model}:large-clients=${config.largeClientSearch}`, resolve };
}
export type IdentityResolver = ReturnType<typeof createIdentityResolver>;

/** Compare the fresh records used by preparation with the identities actually judged. Price-only changes are allowed. */
export function changedIdentities(decisions: Decision[], products: Product[], clients: Client[]): Issue[] {
  return decisions.flatMap(d => {
    if (d.status !== 'matched') return [];
    const records = d.field === 'client' ? clientCandidates(clients) : productCandidates(products);
    const record = records.find(r => r.id === d.selectedId);
    return record && identityHash(record) === d.identityHash && (d.source === 'operator' || snapshotHash(records) === d.snapshotHash) ? [] : [{ field: d.field, matchingStatus: 'unavailable' as const, message: 'Catalogue identity changed during preparation. Retry to resolve the current record.' }];
  });
}
