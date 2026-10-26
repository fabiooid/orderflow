# Release readiness

Assessed on 26 October 2026 against `main` at `fddb81e`. This note describes the repository, not any deployment. It contains no business data.

## Verdict

**OrderFlow can be released today as an open-source, pre-1.0 developer preview.** The repository is already public under MIT, CI runs on Node 22 and 24, and everything a newcomer can run without credentials passes. The architecture rules hold: core folders import only contracts, and the boundaries check enforces it.

**It is not ready for a production pilot.** Nothing has saved a confirmed order against a live account yet. There is no hosting story or authentication, and the live-agent baselines predate the most recent behaviour change. The release-day fixes are small. The pilot blockers are operational work, not code quality.

So "release" has two meanings:

| Meaning | Status |
| --- | --- |
| **`v0.1.0` developer preview**: a tagged GitHub release with notes, clearly marked pre-pilot. Anyone can clone it, run the demo and offline suites, and read the adapter contracts. | Ready after the must-fix list below (about a day of work). |
| **Production pilot**: one operator group saving real orders on a hosted runner. | Blocked. See [Pilot blockers](#pilot-blockers). |
| **npm package** | Not a goal. `private: true` is correct: this is an application with composition roots, not a library. Keep it. |

## What was verified

All of these ran with credentials blanked and `CONNECTOR_MODE=demo`, so nothing could reach a live service.

| Check | Result |
| --- | --- |
| `npm run check` | Pass |
| `npm run boundaries` | Pass ("Import boundaries hold.") |
| `npm test` | 37 files, 252 tests pass in about 3 s |
| `npm run config:check` (example config) | Pass |
| `npm run demo` | Pass. Scripted run, simulated save with one retry. |
| `npm run eval:acceptance -- --offline` | 6/6 pass |
| `npm run eval:conversations -- --offline` | **Crashes**: "--offline needs scripted drafts for every case". See [Mastra evals](#mastra-evals). |
| `npm run build` (Mastra) | Pass. Produces `.mastra/output`. |
| `npm audit --omit=dev` | 10 advisories (5 high, 5 moderate). Most are fixed by open Dependabot PRs. |
| Tracked-file scan for secrets and real-looking business data | Clean. VAT numbers in fixtures are placeholders (`IT00000000001`, `IT01234567890`, `DEMO-NOT-A-REAL-VAT`). |
| GitHub | Public, MIT detected, private vulnerability reporting enabled, no tags or releases. |

No live model, matcher, Fatture in Cloud or Telegram calls were made.

## Mastra evals

There are four kinds of evaluation. Only the first is a "Mastra eval" in the library sense.

1. **Judge scorers** (`src/assistant/manual-scorers.ts`, `live-evals.ts`, `src/channel/evaluation.ts`). Six LLM-judge scorers from `@mastra/evals/scorers/prebuilt`, attached natively to agent runs and the delivered-reply workflow.
2. **Deterministic order-form scorers** (`order-form-scorers.ts`, `eval:orderforms`). These need a private dataset of real forms, by design.
3. **Acceptance and conversation suites** (`src/evals/`, `eval:acceptance`, `eval:conversations`). These run the real controller and engine against `DemoConnector`, use exact-field checks, and have no judge.
4. **Matcher smoke tests** (`eval:matching`, `eval:matching:workflow`, `scripts/eval-large-clients.ts`). These make real matcher calls.

### Fine for an OSS pre-1.0

- **The Vitest peer override works.** `@mastra/evals@1.10.5` declares an *optional* peer `vitest >=3 <5`, and the project uses Vitest 5. The scoped `overrides` entry dedupes it onto the project's Vitest, and `npm ci` resolves cleanly in CI. The project uses only the runtime scorer factories, not the Vitest matchers, so the peer range is irrelevant at runtime. The latest `@mastra/evals` (1.10.8) still declares `<5`, so the override is needed for now. It is documented in `docs/evals.md`.
- **Mastra upgrades are not the risk.** Dependabot PR #42 moves `@mastra/core` 1.71 → 1.78 and `@mastra/evals` 1.10.5 → 1.10.7. Its single failure is in the matcher, not in evals (see below). Every eval and scorer test passed on that PR.
- The scorer tests (`tests/manual-scorers.test.ts`, `tests/live-evals.test.ts`) stub the judges and run offline.
- Offline acceptance (6 cases) runs the real controller end to end with no model.

### Broken

- **`eval:conversations --offline` cannot run.** `runEvals` refuses `--offline` unless every selected case has `scripted` drafts, and none of the 20 conversation cases has them. `docs/evals.md` said `--offline` "uses scripted drafts where a case has them". This branch corrects the doc. The real fix is either to script a few conversation cases or to drop the flag from that suite.

### Fragile

- **Background judge scoring is on by default.** `liveEvalSettings` defaults `EVALS_ENABLED` to `true` at a 10% sample, and `.env.example` sets it to `true`. Anyone who adds an `OPENAI_API_KEY` therefore sends a sample of operator conversations, which include customer names, addresses and VAT numbers, to the judge provider and pays for it, without opting in. For a public tool, default it off and document how to opt in. This changes behaviour, so it needs its own PR and a test update, not a drive-by edit.
- **The live baselines are stale.** The last live results in `docs/planning/run-log.md` are from 7–9 October (acceptance 6/6 and conversations 14/14 with `openai/gpt-5-mini`). Since then the suite has grown to 20 conversation cases, and #34 changed product search to match by meaning. No live result exists for the current prompt and search.
- **The judges are uncalibrated.** `docs/evals.md` already says so: there are no thresholds, no aggregate score, and no human-labelled comparison. That is acceptable for a preview. It is not evidence for a pilot.
- **Scoring is best-effort.** Pending scores live in process memory, so a crash loses them. This is documented and acceptable.
- **Vitest is in the production install tree.** Because `@mastra/evals` is a runtime dependency with Vitest as a peer, `vitest`, `@vitest/mocker` and `vite` are marked `devOptional` and survive `npm ci --omit=dev`. They also appear in the production audit. The Mastra build output does not bundle them. This is cosmetic today, but it inflates audit noise.
- `scripts/eval-large-clients.ts` has no npm script and is only referenced from `docs/jev.md`.

### Not blocking

- The README's "Evaluations" section lists only the six judge scorers. The deterministic suites are documented in `docs/evals.md`, which is the right place.

## Checklist

### Must fix before tagging `v0.1.0`

- [ ] **Unblock Dependabot PR #42.** It carries the `zod` 4.6.7 fix for a high-severity advisory, plus the Mastra bumps. It fails only on `tests/matching.test.ts › uses the official SDK wire format without live network access`, because `@typesafe-ai/sdk` 0.6 → 0.7 changed the wire format and the selector now returns `unavailable`. Split it: take everything except the Typesafe SDK now, and adapt `src/matching/jev-client.ts` to 0.7 separately. Do not weaken the test.
- [ ] **Merge the green Dependabot PRs**: #35 (actions), #37 (dev group), #39 (vite), #40 (hono), #41 (follow-redirects), #43 (vitest). All pass CI. Treat #38 (TypeScript 7, major) separately. It is green, but a compiler major deserves a deliberate look.
- [ ] **Make background judge scoring opt-in**, or at least set `EVALS_ENABLED=false` in `.env.example` and say plainly in the README that enabling it sends conversation samples to the judge provider.
- [ ] **Fix the README module table and diagram**: `src/telegram` no longer exists. *Done on this branch.*
- [ ] **Correct the `eval:conversations --offline` description.** *Done on this branch.*
- [ ] **Write release notes and tag `v0.1.0`** as a GitHub pre-release. State "pre-pilot, never used against a live production account" in the first lines.

### Should fix

- [ ] Add `SECURITY.md`. Private vulnerability reporting is enabled and the README points to it, but GitHub shows no security policy.
- [ ] Add a `CHANGELOG.md`, or rely on generated release notes and say so in CONTRIBUTING.
- [ ] README structure: the "JEV data selection" section sits after "License". Move it under Configuration and present it as the optional matcher, not a vendor feature. Add `src/documents` and `src/matching` to the module table. Add `boundaries`, `eval:orderforms`, `eval:matching`, `eval:matching:workflow`, `orderform:import` and `pricetier:suggest` to the scripts table.
- [ ] `package.json` description says "for Fatture in Cloud". Consider "for invoicing backends (Fatture in Cloud adapter included)" to match the adapter architecture.
- [ ] Fix `eval:conversations --offline` for real: script two or three cases, or remove the flag for this suite.
- [ ] Update `docs/planning/jev-implementation-plan.md` paths (`src/telegram/*` → `src/channel/*`), or label it clearly as historical.
- [ ] Add an npm script for `eval-large-clients.ts`, or move it under `docs/`.
- [ ] Add issue and PR templates, including a "no real customer data" reminder.

### Nice to have

- [ ] A fresh live baseline in `run-log.md` for acceptance, conversations and matching workflow on the current `main`.
- [ ] Re-check whether a newer `@mastra/evals` widens its Vitest peer range, so the override can go.
- [ ] Separate the runtime scorer dependency from Vitest, or accept and document the `devOptional` audit noise.
- [ ] Remove the `JEV_*` aliases at 1.0 with a migration note (deprecated today, per AGENTS.md).
- [ ] A second fictional channel or connector stub as living proof that the contracts are sufficient.

## Pilot blockers

These do not block an open-source preview. They block real orders.

1. **No live confirmed order yet.** This is the user-acceptance step on the README checklist. Run it in `read-only` mode first, then with `orderSavingEnabled: true` and a token scoped to orders only.
2. **No hosting or authentication.**
   - The Telegram runner uses long polling and needs no public URL, which helps.
   - `npm run build` produces a Mastra server, and Studio has no authentication. It must not be exposed.
   - Every runtime script, `telegram:start` included, runs through `tsx`, which is a devDependency. A production install cannot use `--omit=dev` until there is a compiled entrypoint or `tsx` moves to dependencies.
   - There is no Dockerfile or process-manager example. The planned EU host needs a minimal runbook: process supervision, a persistent `.data/` volume for the write journal and Mastra storage, and secrets in the environment.
3. **No current live-model evidence.** Re-run acceptance and conversations on the current prompt and search before the pilot, and record the results.
4. **The uncertain-write and uncertain-delivery runbooks are untested live.** Rehearse `write:recover` and `telegram:recover` once against the read-only account before saving is enabled.
5. **The eval data-flow decision.** Decide whether pilot conversations may go to a judge provider at all, and set `EVALS_ENABLED` accordingly.

## Next work, in order

Each item is small enough for one issue.

1. Merge the green Dependabot PRs (#35, #37, #39, #40, #41, #43).
2. Split #42: land the Mastra, zod, ai-sdk and canvas bumps and leave out `@typesafe-ai/sdk`. Re-run `npm audit --omit=dev`.
3. Adapt `src/matching/jev-client.ts` to `@typesafe-ai/sdk` 0.7 and keep the wire-format test strict.
4. Make background judge scoring opt-in (`EVALS_ENABLED` default `false`), with test and doc updates.
5. README tidy-up: move the JEV section, complete the module and scripts tables, adjust the `package.json` description.
6. Add `SECURITY.md` and issue/PR templates.
7. Script two or three conversation cases so that `eval:conversations --offline` runs, and add it to CI next to the offline acceptance run.
8. Add `eval:acceptance -- --offline` to CI.
9. Decide on TypeScript 7 (#38).
10. Write release notes and tag `v0.1.0` as a GitHub pre-release.
11. *Pilot track:* fresh live baselines for acceptance, conversations and matching workflow, recorded in `run-log.md`.
12. *Pilot track:* a production entrypoint that does not need `tsx` from devDependencies, plus a minimal host runbook (supervision, persistent `.data/`, secrets).
13. *Pilot track:* rehearse both recovery runbooks in read-only mode.
14. *Pilot track:* the first supervised live confirmed order. Then tick the README checklist.
