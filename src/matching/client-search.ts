import { createHash } from 'node:crypto';
import { selectionRequestSchema, type SelectionRequest, type SelectionResult } from './types.js';

const GROUP_SIZE = 253;
// Bound request size/cost. Above this, require a city/VAT or an explicit record choice.
export const MAX_CLIENT_SEARCH = GROUP_SIZE * 10;
type SelectMany = (requests: SelectionRequest[]) => Promise<SelectionResult[]>;

/** Search every eligible customer, without treating lexical retrieval as proof of coverage.
 * Each group uses the original name/context. Probabilities from separate groups are
 * never compared: only one match plus exhaustive no-matches can resolve an identity.
 */
export function withCompleteClientSearch(selectMany: SelectMany): SelectMany {
  return async requests => {
    if (!requests.length) return selectMany(requests);
    const groups: SelectionRequest[] = [];
    const plans = requests.map(request => {
      const start = groups.length;
      if (request.kind !== 'client' || request.candidates.length <= GROUP_SIZE) {
        groups.push(request);
        return { start, count: 1, request };
      }
      const valid = request.candidates.length <= MAX_CLIENT_SEARCH && request.retrieval.complete &&
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
    const results = groups.length ? await selectMany(groups) : [];
    return plans.map(({ start, count, request }): SelectionResult => {
      if (count === 1) return results[start]!;
      const parts = results.slice(start, start + count);
      const evidence: SelectionResult['evidence'] = {
        requestHash: createHash('sha256').update(JSON.stringify({ request, parts })).digest('hex'),
        promptVersion: 'complete-client-search-v1', retrieval: request.retrieval,
        elapsedMs: Math.round(performance.now() - started),
        // Keep each group's evidence; there is no meaningful aggregate confidence.
        groups: parts.map((part, i) => ({ candidateIds: groups[start + i]!.candidates.map(c => c.id),
          status: part.status, selectedId: part.selectedId, evidence: part.evidence })),
      };
      if (!count) return { status: 'unavailable', reason: 'invalid-input', evidence };
      if (parts.length !== count || parts.some((part, i) => part.status === 'unavailable' ||
        (part.status === 'matched' && !groups[start + i]!.candidates.some(c => c.id === part.selectedId)))) {
        return { status: 'unavailable', reason: 'service-unavailable', evidence };
      }
      const matches = parts.filter(part => part.status === 'matched');
      if (parts.some(part => part.status === 'ambiguous') || matches.length > 1) return {
        status: 'ambiguous', evidence,
        clarificationIds: [...matches.map(part => part.selectedId!), ...parts.flatMap((part, i) =>
          part.status === 'ambiguous' ? groups[start + i]!.candidates.map(c => c.id) : [])],
      };
      return matches.length === 1 ? { status: 'matched', selectedId: matches[0]!.selectedId, evidence } : { status: 'no-match', evidence };
    });
  };
}
