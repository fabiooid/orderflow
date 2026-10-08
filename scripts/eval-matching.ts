import { loadMatchingConfig } from '../src/matching/config.js';
import { createJevSelector, sdkTransport } from '../src/matching/jev-client.js';
import { matchingFixtures } from '../src/matching/fixtures.js';

// Fictional data only. No Fatture in Cloud connector, Telegram or memory access.
try {
  const config = loadMatchingConfig(process.env);
  if (config.mode === 'off') throw new Error('disabled');
  const select = createJevSelector(config, sdkTransport(config, process.env.TYPESAFE_API_KEY!));
  let passed = 0;
  let wrongSelections = 0;
  let unavailable = 0;
  for (const fixture of matchingFixtures) {
    // Reverse candidates as an independent stability check; IDs remain the same.
    for (const reverse of [false, true]) {
      const request = { ...fixture.request, candidates: reverse ? [...fixture.request.candidates].reverse() : fixture.request.candidates };
      const result = await select(request);
      const actual = result.status === 'matched' ? result.selectedId : result.status;
      const ok = actual === fixture.expected;
      passed += Number(ok);
      wrongSelections += Number(result.status === 'matched' && !ok);
      unavailable += Number(result.status === 'unavailable');
      console.log(JSON.stringify({ case: fixture.name, reversed: reverse, passed: ok, expected: fixture.expected,
        actual, reason: result.reason, model: result.evidence.model, confidence: result.evidence.confidence,
        usage: result.evidence.usage, elapsedMs: result.evidence.elapsedMs, requestHash: result.evidence.requestHash }));
    }
  }
  const total = matchingFixtures.length * 2;
  console.log(JSON.stringify({ passed, total, wrongSelections, unavailable }));
  if (passed !== total) process.exitCode = 1;
} catch {
  console.error('Matching evaluation could not start. Set JEV_MODE=shadow and TYPESAFE_API_KEY; check JEV configuration. No records were written.');
  process.exitCode = 1;
}
