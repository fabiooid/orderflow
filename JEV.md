# JEV matching foundation

The first implementation phase provides a read-only selection adapter around
`@typesafe-ai/sdk`, explicit product/client projections, validated result contracts,
and reproducible fictional evaluation fixtures. It does not yet change Telegram or
Studio matching, learn aliases, or write Fatture in Cloud records.

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

- `JEV_MODE`: `off` (default), `shadow`, or `on`. These values currently configure
  the standalone selector only. Neither `shadow` nor `on` activates live workflow
  matching until the workflow integration phase is implemented.
- `JEV_MODEL`: defaults to `jev-1.13.0`; the response records the actual model.
- `JEV_TIMEOUT_MS`: total request budget including retries, default 15000.
- `JEV_MAX_RETRIES`: SDK retries after the first attempt, default 1, maximum 2.

The adapter returns `matched`, `ambiguous`, `no-match`, or `unavailable`. A matched
ID is always copied from a supplied candidate. It is a judgment, not permission to
apply a draft change, save a document, or remember an alias. Application-owned
selection evidence and calibrated acceptance policy are required before live use.

Only complete sets of up to 253 candidates are accepted. Larger or incomplete sets
fail explicitly; they are not silently truncated. History pagination, chunked
retrieval, batching across independent selections, browsing relevance judgments,
hard-constraint validation, native Mastra workflow integration and operator-backed
alias learning remain in the implementation plan.

SDK logging is disabled; errors returned to callers contain only stable reason
codes. No service body, credentials, full client address or contact information is
included in diagnostics. Candidate projections omit pricing because selecting an
identity must not silently select a price.
