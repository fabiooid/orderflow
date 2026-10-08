# JEV identity matching

JEV is integrated into product and customer resolution in the shared Telegram/Studio
order workflow. GPT interprets requests; application code validates JEV’s selections
before preparing prices, taxes and totals. Writes still require the existing latest
preview confirmation. `JEV_MODE=off` remains the default; no deployment is activated
by installing this integration.

## Run the evaluation

Set `TYPESAFE_API_KEY` privately in `.env`, then run:

```sh
JEV_MODE=shadow npm run eval:matching
```

The command submits ten fictional product/client cases twice, reversing candidate
order on the second pass. It reports expected/actual selections, confidence, model,
token usage, elapsed time and a request fingerprint. It exits unsuccessfully if any
case fails. It never imports a Fatture in Cloud connector or Telegram client.
The `exact-code` case also serves as a read-only connection check.

These are smoke cases, not held-out accuracy evidence or a basis for choosing a
production confidence threshold. API availability failures are counted separately
from wrong selections. Unit tests use injected transport and require no credentials.

Initial live run on 7 October 2026: 20/20 checks passed with `jev-1.13.0`, zero
wrong selections and zero unavailable results. Calls took approximately 0.43–1.33
seconds. This small fictional smoke run does not measure real-catalogue accuracy.

## Configuration and boundaries

- `JEV_MODE`: `off` (default), `shadow`, or `on`. These values configure
  Telegram, Studio and the standalone selector. `off` uses legacy matching; `shadow`
  records decisions without changing draft identities or blocking preparation; `on`
  makes application-validated JEV selections authoritative.
- `JEV_MODEL`: defaults to `jev-1.13.0`; the response records the actual model.
- `JEV_TIMEOUT_MS`: total request budget including retries, default 15000.
- `JEV_MAX_RETRIES`: SDK retries after the first attempt, default 1, maximum 2.

The adapter returns `matched`, `ambiguous`, `no-match`, or `unavailable`. A matched
ID is always copied from a supplied candidate. It is a judgment, not permission to
apply a draft change, save a document, or remember an alias. Workflow evidence records order/revision/input and candidate hashes, selected IDs,
source, model, prompt version and distributions separately from model output.
The integration does not invent a confidence threshold: calibrate rollout on held-out
realistic cases before enabling `on` in a live deployment.

Only complete sets of up to 253 candidates are accepted. Larger or incomplete sets
fail explicitly; they are not silently truncated. Independent client/product judgments are batched in one request. The application
filters shipping, tester status, explicit codes and sizes, and structured customer
tax identity and explicitly named catalogue cities before applying a result. History pagination/selection, chunked
retrieval and semantic multi-result browsing remain separate work; browsing still
uses the existing search tools.

SDK logging is disabled; errors returned to callers contain only stable reason
codes. No service body, credentials, full client address or contact information is
included in diagnostics. Candidate projections omit pricing because selecting an
identity must not silently select a price.

## Workflow behavior

`prepare-order` runs a native `resolve-identities` step before preparation. Resuming
clarification re-runs resolution, so an edited draft cannot bypass it. Every revision
reads current catalogue/customer records. Operator choices are retained only while
the field query and record identity hashes match; other decisions are re-resolved.
Preparation checks its fresh identity snapshot again before calculating totals. The extraction model’s IDs are ignored in `on` mode;
failed or ambiguous judgments never fall through to lexical selection.

Original operator messages survive Telegram routing paraphrases. Exact current
codes/canonical names and deliberate choices such as `line 1: 101` or `client: 201`
are resolved in code against current records. These explicit choices bypass model
extraction in Telegram and cannot select shipping or missing records. Form canonical
names follow the same rules; duplicate names require clarification. IDs embedded
in model output alone are never proof of a form mapping.

Ambiguity produces identity-labelled choices. An operator can reply `riga 1: 101`
or `cliente: 201` in Italian. Semantic lookup tools `resolveProduct` and
`resolveClient` use the same resolver in `on` mode. Existing search tools remain for
browsing. New aliases in `on` mode additionally require the operator’s source words
to explicitly name a unique current code/name/VAT identity; a prediction alone
cannot authorize learning.

Mode/model policy changes into authoritative matching invalidate old Telegram
confirmation buttons. Finish or cancel open requests before switching modes. No
mode change or poller restart is performed by this code change.

For Studio workflow resumes, supply `draft`, `operatorText` (the original context),
`latestOperatorText` (the current correction/choice), and `revision`. Telegram
supplies these automatically. Context is bounded to 12,000 characters; overlong
requests need a fresh conversation rather than silently truncating identity evidence.

## Evaluate the integrated path

```sh
JEV_MODE=on npm run eval:matching:workflow
```

This runs the shared native order workflow with scripted extraction, fictional API
records, and real JEV calls. It checks semantic products/customers, ambiguity and
identity conflicts without FIC access, Telegram, or saves. On 8 October 2026 all
10 smoke cases passed after a repeat run exposed a city/VAT conflict and a deterministic city constraint was added. This is connection/integration evidence, not production
accuracy calibration. Offline tests cover outages, invalid selections, shadow/off,
resume, original-text preservation, explicit choices and alias authorization.
