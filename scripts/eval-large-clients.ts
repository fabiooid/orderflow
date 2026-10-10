import { loadMatchingConfig } from '../src/matching/config.js';
import { createJevBatchSelector, sdkTransport } from '../src/matching/jev-client.js';
import { withCompleteClientSearch } from '../src/matching/client-search.js';
import type { SelectionRequest } from '../src/matching/types.js';

// Fictional capacity smoke test; raw transport usage is counted once per API call.
const config = { ...loadMatchingConfig(), mode: 'on' as const };
const transport = sdkTransport(config, process.env.TYPESAFE_API_KEY ?? '');
let failed = false;
for (const size of process.argv.includes('--maximum-only') ? [2530] : [600, 2530]) {
  const calls: unknown[] = [];
  const select = withCompleteClientSearch(createJevBatchSelector(config, async (request, signal) => {
    const start = performance.now();
    let raw: unknown;
    try { raw = await transport(request, signal); }
    catch (error) {
      const e = error as { status?: number; statusCode?: number };
      calls.push({ questions: Object.keys(request.questions).length, ms: Math.round(performance.now() - start), failed: true, httpStatus: e.status ?? e.statusCode });
      throw error;
    }
    const response = raw as { usage?: unknown; model?: string };
    calls.push({ questions: Object.keys(request.questions).length, ms: Math.round(performance.now() - start), usage: response.usage, model: response.model });
    return raw;
  }), true);
  const request: SelectionRequest = { kind: 'client', query: 'Luna Botanica di Milano', context: 'Prepare an order for Luna Botanica di Milano',
    candidates: Array.from({ length: size }, (_, i) => ({ id: String(i + 1), name: i === size - 1 ? 'Luna Botanica SRL' : `Fictional Trading Company ${i + 1}`, city: i === size - 1 ? 'Milano' : ['Roma', 'Torino', 'Napoli'][i % 3]!, country: 'IT', vatNumber: `TEST${String(i + 1).padStart(8, '0')}` })),
    retrieval: { complete: true, furtherSearchPossible: false } };
  const start = performance.now();
  const [result] = await select([request]);
  const passed = result?.status === 'matched' && result.selectedId === String(size);
  failed ||= !passed;
  console.log(JSON.stringify({ size, passed, status: result?.status, selectedId: result?.selectedId, elapsedMs: Math.round(performance.now() - start), calls }));
}
if (failed) process.exitCode = 1;
