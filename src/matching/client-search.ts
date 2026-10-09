import { createHash } from 'node:crypto';
import { PROMPT_VERSION } from './jev-client.js';
import { selectionRequestSchema, type SelectionRequest, type SelectionResult } from './types.js';

const GROUP_SIZE = 253;
// Bound request size/cost. Above this, require a city/VAT or an explicit record choice.
export const MAX_CLIENT_SEARCH = GROUP_SIZE * 10;
type SelectMany = (requests: SelectionRequest[]) => Promise<SelectionResult[]>;

/** Search every eligible customer, without treating lexical retrieval as proof of coverage.
 * Each group uses the original name/context. Probabilities from separate groups are
 * never compared: only one match plus exhaustive no-matches can resolve an identity.
 */
export function withCompleteClientSearch(selectMany: SelectMany, enabled = false): SelectMany {
  return async requests => {
    if (!requests.length) return selectMany(requests);
    const groups: SelectionRequest[] = [];
    const plans = requests.map(request => {
      const start = groups.length;
      if (request.kind !== 'client' || request.candidates.length <= GROUP_SIZE) {
        groups.push(request);
        return { start, count: 1, request };
      }
      const valid = enabled && request.candidates.length <= MAX_CLIENT_SEARCH && request.retrieval.complete &&
        !request.retrieval.furtherSearchPossible && new Set(request.candidates.map(c => c.id)).size === request.candidates.length;
      if (!valid) return { start, count: 0, request };
      for (let i = 0; i < request.candidates.length; i += GROUP_SIZE) {
        const group = { ...request, candidates: request.candidates.slice(i, i + GROUP_SIZE) };
        if (!selectionRequestSchema.safeParse(group).success) {
          groups.splice(start);
          return { start, count: 0, request };
        }
        groups.push(group);
      }
      return { start, count: groups.length - start, request };
    });
    const started = performance.now();
    // Separate calls isolate large customer request failures from product judgments.
    const results: SelectionResult[] = [];
    const small = plans.filter(p => p.count === 1);
    const isolated = plans.filter(p => p.count > 1);
    const batches = [small.flatMap(p => [p.start]), ...isolated.map(p => Array.from({ length: p.count }, (_, i) => p.start + i))];
    await Promise.all(batches.filter(indices => indices.length).map(async indices => {
      try {
        const batch = await selectMany(indices.map(i => groups[i]!));
        indices.forEach((index, i) => { results[index] = batch[i] ?? unavailable(groups[index]!); });
      } catch { indices.forEach(index => { results[index] = unavailable(groups[index]!); }); }
    }));
    return plans.map(({ start, count, request }): SelectionResult => {
      if (count === 1) return results[start]!;
      const parts = results.slice(start, start + count);
      const evidence: SelectionResult['evidence'] = {
        requestHash: createHash('sha256').update(JSON.stringify({ request, promptVersion: PROMPT_VERSION, strategy: 'complete-client-search-v2' })).digest('hex'),
        promptVersion: PROMPT_VERSION, strategy: 'complete-client-search-v2', retrieval: request.retrieval,
        model: parts.length && parts.every(p => p.evidence.model === parts[0]!.evidence.model) ? parts[0]!.evidence.model : undefined,
        elapsedMs: Math.round(performance.now() - started),
        // Keep each group's evidence; there is no meaningful aggregate confidence.
        groups: parts.map((part, i) => ({ candidateCount: groups[start + i]!.candidates.length,
          candidateHash: createHash('sha256').update(JSON.stringify(groups[start + i]!.candidates)).digest('hex'),
          status: part.status, selectedId: part.selectedId, reason: part.reason,
          evidence: { requestHash: part.evidence.requestHash, promptVersion: part.evidence.promptVersion,
            model: part.evidence.model, elapsedMs: part.evidence.elapsedMs } })),
      };
      if (!count) return { status: 'unavailable', reason: enabled ? 'invalid-input' : 'disabled', clarificationIds: [], evidence };
      if (parts.length !== count || parts.some((part, i) => part.status === 'unavailable' ||
        (part.status === 'matched' && !groups[start + i]!.candidates.some(c => c.id === part.selectedId)))) {
        return { status: 'unavailable', reason: 'service-unavailable', evidence };
      }
      const matches = parts.filter(part => part.status === 'matched');
      if (parts.some(part => part.status === 'ambiguous') || matches.length > 1) return {
        status: 'ambiguous', evidence,
        clarificationIds: matches.map(part => part.selectedId!),
      };
      return matches.length === 1 ? { status: 'matched', selectedId: matches[0]!.selectedId, evidence } : { status: 'no-match', evidence };
    });
  };
}

function unavailable(request: SelectionRequest): SelectionResult {
  return { status: 'unavailable', reason: 'service-unavailable', evidence: { requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'), promptVersion: PROMPT_VERSION, retrieval: request.retrieval, elapsedMs: 0 } };
}
