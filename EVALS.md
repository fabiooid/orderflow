# OrderFlow evaluations

The six scorer definitions support manual and native Mastra live evaluation.
Automatic evaluation is enabled by default at 100% of eligible runs. Mastra handles
sampling, asynchronous execution and score storage; evaluations never gate saves,
retry orders, alter replies or send customer messages.

## Automatic scoring

- `EVALS_ENABLED=true` enables attachments. Set `false` for manual-only operation.
- `EVALS_SAMPLE_RATE=1` scores every eligible run; `0.1` samples 10%.
- Restart the Telegram runner and reload Studio after changing these settings.
- Tool accuracy and workflow adherence attach to actual model runs, including
  routing/extraction. Internal question-wording calls are excluded.
- Studio conversational runs also have the four text/conversation checks.
- Telegram text/conversation checks run on the **delivered reply**, not internal
  routing/extraction JSON. The `telegram-delivered-reply` workflow has a single
  evidence step with native `scorers` attachments. It includes the last 100 stored
  group messages, operator IDs, the actual reply and available application state
  (draft, summary, saved-order identity, confirmed customer-save status).
- Delivered-reply scores use `telegram-` IDs and `Telegram:` names so they can be
  distinguished from model-run scores. These are the same criteria, not new metrics.
- Application-outcome workflow adherence is distinct from model trajectory scoring:
  it sees the recorded outcome, not an invented trace of the API implementation.
- A replay of an already recorded update does not dispatch another evaluation.
  Dispatch/history failures skip evaluation without changing delivered replies or
  business state. There is no durable scoring retry queue: crashes can lose pending
  scores; recorded evidence remains available for manual investigation.

If Telegram times out on this machine's dual-stack network, the verified startup command is:

```sh
node --dns-result-order=ipv4first --env-file-if-exists=.env --import tsx scripts/telegram.ts
```

There are two Mastra workflows: `prepare-order` extracts, validates, calculates and
suspends/resumes for missing details; `telegram-delivered-reply` exposes delivered
conversation evidence to native background scorers. Customer/order saving remains
in the existing confirmation-controlled application code.

## Judge configuration

The default is `openai/gpt-4.1-mini`, using `OPENAI_API_KEY`. To override it,
set `EVAL_JUDGE_MODEL=provider/model` in your local `.env` and reload Studio.
This does not change the agent model in the business configuration.

## Running manually

1. Start/reload Studio with `npm run dev` using your existing local configuration.
2. Under **Observability**, open a real agent trace and choose the scoring action.
3. Select the relevant scorer, run it, then inspect its score, reason and evidence.
   Workflow adherence uses trajectory data, so select a complete trace/trajectory.
4. Review results in the **Scorers** list. Manual scoring remains available when
   `EVALS_ENABLED=false`; live results appear there automatically when enabled.

A judge run sends the selected conversation and available tool results to the
configured model provider. It only evaluates recorded evidence: it does not replay
agent actions or call Fatture in Cloud. There is no customer/order creation tool
available to the judges.

## What the scores mean

- **Tool call accuracy** (`tool-call-accuracy`): Mastra's built-in LLM tool-selection
  scorer, supplied the actual callable names plus native skill meta-tools. Prior
  context is included. Clarification without a tool call can be correct.
  Inspect `missingTools` in the analysis as well as the numerical score: the
  built-in formula can score appropriate calls highly even when another tool is missing.
- **Workflow adherence / trajectory** (`workflow-adherence`): Mastra's built-in
  trajectory scorer plus a Rubric check for bypassing the application creation
  flow, inventing replacement procedures or falsely claiming writes. The result
  is the lower of those two scores; both analyses remain available. The agent's
  search-only tools are not expected to create records. Application confirmation
  and save events can only be assessed when present in the supplied evidence.
- **Conciseness** (`conciseness`): Mastra Rubric. Grades the final user-facing reply,
  allowing complete summaries and necessary details. No rigid word limit.
- **Language consistency** (`language-consistency`): Mastra Rubric. Grades only
  assistant-authored prose, following the latest substantive user language unless
  an explicit preference exists. ALL API-sourced content is exempt, including
  product descriptions, company addresses, names, identifiers and codes.
- **Context retention** (`context-retention`): Mastra Multi-turn Judge with a
  role-labelled evidence adapter. Checks continuity of the active request and
  supplied facts across follow-ups, corrections and side questions.
- **User-reported mistakes** (`user-reported-mistakes`): Mastra Multi-turn Judge
  with the same adapter. A user explicitly reporting an incorrect prepared/saved
  result fails, even if subsequently repaired. Defaults overridden, changed minds,
  new details and clarification answers are not mistakes. Reasons distinguish
  before-save, after-save or unknown timing when evidence permits. **A pass means
  no user-reported mistake was observed, not verified first-time correctness.**

The four text/conversation scores are binary: 1 passes, 0 fails. Tool accuracy and
workflow adherence retain Mastra's numerical scoring; they are not calibrated
probabilities. In particular, an otherwise ideal built-in trajectory can score
0.9. No pass thresholds or aggregate score have been configured.

## Evidence boundaries

The adapter preserves remembered messages, current inputs and outputs, deduplicated
by message ID, with roles and tool-result provenance. It supplies both sides of the
conversation to the multi-turn judge because the unadapted built-in reads only
assistant output. The delivered-reply workflow retrieves a bounded memory window; manual model-trace
scoring uses only the history already in that trace. Neither reconstructs missing
events nor assumes that a trace includes the whole request.

Choose a later conversational agent trace that contains the relevant remembered
history for context/correction checks. Without a user follow-up after an assistant
reply those checks return **not scorable**, without spending on the judge. Missing
user/assistant text and structured extraction outputs are also skipped by style
checks. Imported Telegram placeholders cannot recover the original conversation.
New delivered-reply evaluations include application summaries and available save
state. Older imported placeholders still cannot recover absent data. Tool/API
results from separate model traces are not automatically joined into the delivery
workflow; provided drafts/prepared records help identify copied API fields. A model
trace alone cannot establish whether the ultimately saved record was correct.

Before relying on scores, manually compare a small sample against human judgments,
including actual mistakes, harmless default overrides, mixed-language API records,
and long but necessary order summaries. Offline tests validate evidence handling,
skips and score propagation; they do not establish judge accuracy.

## Implementation and dependencies

- `src/assistant/manual-scorers.ts`: built-in scorer configuration and stable IDs.
- `src/assistant/eval-evidence.ts`: role/provenance-preserving evidence adapter.
- `src/assistant/live-evals.ts`: native attachment filters and sampling settings.
- `src/telegram/evaluation.ts`: delivered-reply workflow and step scorer adapters.
- `src/mastra/index.ts`: Studio registration and live attachments.
- `tests/live-evals.test.ts`: native background scoring/storage integration tests.
- `tests/manual-scorers.test.ts`: offline regression coverage with stubbed judges.

`@mastra/evals` is pinned to 1.10.5. Its optional Vitest peer declares versions below
5, while this project uses Vitest 5. A scoped package override retains the existing
runner. We use only runtime scorer factories, not Mastra's Vitest matcher integration.
Normal `npm install`/`npm ci` resolve with that override; do not use a global
`legacy-peer-deps` setting.

References: [Mastra evaluations](https://mastra.ai/docs/evals/overview),
[Rubric](https://mastra.ai/reference/evals/rubric),
[Multi-turn Judge](https://mastra.ai/reference/evals/multi-turn-judge),
[Tool call accuracy](https://mastra.ai/reference/evals/tool-call-accuracy),
[Trajectory accuracy](https://mastra.ai/reference/evals/trajectory-accuracy).

## Order-form reading

`read-order-form` is a Mastra workflow (identify → two readings in parallel → merge),
so each step appears in traces and Studio. Page images never stay stored: the workflow
keeps no snapshots and the `omit-media` span processor replaces file bytes in traces.

Two deterministic scorers compare a reading with a known order, with no judge-model spend:

- `order-form-no-silent-errors`: share of lines read as certain that are right. Below 1
  means a wrong quantity the operator would not have been asked about.
- `order-form-coverage`: share of the expected order read correctly without a question.

```sh
npm run eval:orderforms -- private/evals/order-forms.json --runs 3
```

A dataset lists real filled-in forms (file, page, expected product ID → quantity), so
keep it out of git. Each run makes model calls. Run it after changing the reading
prompt, the model or a template.

