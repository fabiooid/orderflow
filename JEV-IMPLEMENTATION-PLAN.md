# Jev matching: investigation and implementation plan

Scope: products, clients, and previous orders returned by Fatture in Cloud. Investigated the current working tree on 7 October 2026, including existing uncommitted changes. Architecture and refinements agreed with the user: Jev selects existing data; GPT interprets requests and communicates; Mastra and application code own orchestration, validation, calculations, confirmation, and writes. This is an implementation plan; application behavior has not been changed by this document.

## Recommended architecture

Use Jev as the shared semantic matching and selection service. Keep the conversational model for interpreting messages, extracting quantities and explicit prices, reading media, and wording replies. Code fetches API records, supplies candidates to Jev, validates the returned selection, and copies the selected record's real values into the draft.

Order flow:

1. Interpret the operator's request into structured queries and requested changes, preserving the original operator wording.
2. Read catalogue/client records and confirmed aliases. Jev resolves the client and independently described product lines; batch independent questions within a bounded request.
3. If the request refers to history, retrieve orders for the resolved client, then have Jev resolve the order and, where needed, its specific lines.
4. Resolve historical products against the current catalogue. Ask for clarification when identity, size, or the historical reference is ambiguous.
5. Application code applies validated selections to the draft, prepares prices/taxes/totals, and presents the existing confirmation flow.

Client selection must precede customer-specific history retrieval. Questions within one TypeSafe request cannot depend on other answers in that same request.

## What the code does today

### Products

- `src/assistant/agent.ts:41`: `searchProducts` combines confirmed aliases with `searchCatalogue`; it returns records, not an authoritative match decision. Catalogue search has a two-minute cache.
- `src/domain/matching.ts:43`: exact matching uses normalized codes/names and all-word matching, with Italian plural handling. Loose search counts shared words and returns at most 15 results. A semantic match can be missing entirely when there is no lexical overlap.
- `src/assistant/system-prompt.ts`: the conversational model is instructed to pick `productId` when one returned product fits.
- `src/domain/prepare.ts:46`: preparation accepts an existing supplied product ID with shipping/tester checks. It does not verify that the conversational model's chosen record semantically matches the request. Without an ID it falls back to local matching.

Opportunity: Jev handles synonyms, abbreviations, typos, scent/type/size distinctions, and explicit tester requests. Crucially, it must own the accepted ID, not merely reorder search results before another model picks.

### Clients

- `src/assistant/agent.ts:50`: search requires every normalized word in the name/VAT text, or an exact remembered alias. The returned view omits city, which could distinguish similarly named clients.
- `src/domain/prepare.ts:15`: resolution uses an explicit client ID or an exact normalized name/VAT match.
- `src/assistant/aliases.ts`: product/client aliases are scoped to the deployment and Telegram group and require operator evidence before being remembered.
- `src/telegram/customer.ts` and `src/telegram/order.ts`: duplicate checks use `sameClient` immediately before creation.

Opportunity: Jev resolves shop names versus legal names, imperfect spelling, partial names, and location-qualified requests. Conflicting tax identities and multiple plausible records must remain unresolved. Jev can also flag possible semantic duplicates before the preview, while the existing deterministic duplicate checks remain in the write path.

### Previous orders

- `src/assistant/customer-order-history.ts:14`: a read-only tool validates the customer and returns five recent orders by default, at most twenty. It distinguishes unavailable history from empty history.
- `src/connector/fatture-in-cloud.ts:151`: retrieval reads only page 1, sorted by date, restricted to the client and document type `order`. It discards pagination metadata.
- `src/domain/types.ts`: `ClientOrder` includes order ID/number/date and product lines, but the draft has no structured historical-order reference or selection evidence.
- `src/assistant/system-prompt.ts`: historical selection is currently left to the conversational model. It must cite order number/date, recheck products, and avoid silently reusing prices or discounts.
- `src/domain/history.ts:9`: price comparisons use matching product IDs or codes. Keep arithmetic deterministic; semantic remapping of discontinued products is a separate identity decision.

Opportunity: Jev resolves requests such as “the September order with lavender soap” and “the same products as last time.” Retrieval must first reach the relevant order. A match failure within twenty recent orders cannot establish that an older order does not exist.

## Matching service design

Proposed modules: `src/matching/types.ts`, `src/matching/jev-client.ts`, `src/matching/candidates.ts`, and `src/matching/resolver.ts`.

- Define separate `resolveProduct`, `resolveClient`, and `resolvePreviousOrder` operations with a common typed result: `matched`, `ambiguous`, `no-match`, or `unavailable`.
- A match contains a validated record ID, candidate-set reference, confidence/probabilities, actual model version, and request/prompt version. Non-matches return clarification candidates when available. Retrieval metadata states completeness, time range, and whether further search is possible.
- Use TypeSafe Choice with candidate keys mapped to record IDs, plus explicit `ambiguous` and `no_match` options. Validate the response schema and require the returned key to belong to the supplied set; never accept model-invented IDs or record values.
- For browsing requests such as “show all lavender products,” return a set of relevant records using per-candidate relevance judgments rather than forcing a single Choice. Keep browsing separate from resolving one order line.
- Use confirmed aliases as evidence, but preserve conflicting mappings and contradictory explicit details. Preserve exact IDs supplied through verified application actions or validated form templates; do not confuse an ID emitted by the conversational model with an operator-confirmed choice.
- Use small record projections: product ID/code/name/description; client ID/name/country/VAT and city when needed; order ID/number/date and relevant lines. Exclude credentials and unrelated contact, billing, and document-link fields.
- Prefer the official `@typesafe-ai/sdk` behind a thin injectable adapter. Verify its timeout/cancellation and retry capabilities before adding application-level handling; avoid duplicate retry loops. Validate responses and enforce bounded retries, cancellation, and redacted errors. Use raw HTTP only for an identified SDK limitation. A missing key is a configuration error when Jev is enabled.
- Enforce explicit identity constraints in code where structured data supports them: exact product codes, VAT identity, requested size, and tester status. A confident semantic result cannot override those constraints. Preserve deterministic resolution of verified exact identifiers and explicit operator choices; Jev owns semantic selection where judgment is required.
- Configure the model explicitly and record the resolved version. Evaluate a pinned supported version for rollout rather than relying on an alias staying unchanged. The live smoke test resolved `jev-latest` to `jev-1.13.0`.

## Candidate coverage and retrieval

TypeSafe Choice currently supports at most 255 options. Reserving two outcomes leaves at most 253 record options, but token and latency budgets may require fewer.

For small catalogues, provide all eligible compact records. Do not use the existing top-15 lexical search as the sole candidate source. For larger catalogues, evaluate bounded chunks or a high-recall retrieval stage; preserve multiple plausible candidates across chunks and run a final selection over their union. Scores/probabilities from separate Choice distributions are not globally comparable. Benchmark retrieval recall independently from Jev accuracy, and do not claim exhaustive no-match when the candidate search was incomplete.

Extend the connector with a typed, paginated customer-order search returning records plus continuation/completeness metadata. Support verified SDK/API date and order-number filters where available; confirm those contracts before implementation. Always retain company, client, and `order` document restrictions. Bound pages and request time, then report a limited search if the budget is exhausted. For “last order,” use explicit date ordering and resolve ties rather than assuming a same-date order is uniquely newest.

## Make Jev's decisions authoritative

Adding Jev inside search tools alone is insufficient: the extraction schema still permits arbitrary existing IDs and preparation accepts them.

Introduce a native Mastra workflow resolution step between extraction and preparation, shared by Telegram and Studio, backed by the same resolver used by conversational tools. Ensure resumed preparation runs resolution for changed inputs rather than bypassing it; do not introduce a parallel orchestration framework. It consumes original operator text, structured queries, prior draft, and application-owned evidence. It ignores unverified model-supplied IDs, resolves changed fields, and applies validated Jev results in code. Record evidence separately from free-form model output and bind it to the order, revision, query/context, candidate snapshot, and selected ID.

Reuse a decision only when its inputs are unchanged. A product description, requested size, client, or historical reference change invalidates affected decisions. Client changes invalidate history decisions. If an ID disappears or identity fields change in fresh API data, resolve again or ask; price-only changes do not require semantic rematching but do require a fresh preview.

Keep clarification and choice application in code. An `ambiguous` or `unavailable` result must not fall through to `matchProducts` and silently become a selection. In Jev-enabled mode, there should be no implicit fallback to the conversational model for identity decisions. Operators can still explicitly choose a validated candidate.

The same resolver must back conversational lookup tools. Return selected records or explicit clarification results, update tool descriptions and prompts, and render identity-critical details from the validated result where practical. Free-form prose alone is not enforcement of the selected ID.

Telegram's shared-chat routing can rewrite messages before extraction (`src/telegram/engine.ts`). Preserve original operator text and structured historical references through this path so the resolver can check the actual request, rather than only another model's paraphrase. Studio's workflow and resumed Telegram workflows must run the same resolution rules.

## Alias-learning evidence

The current alias tool checks operator wording and target-record existence, but existence alone does not prove that the selected target is correct. Bind new alias mappings to application-owned evidence of an explicit operator correction or confirmed selection, including the phrase and target ID. A model-supplied ID or Jev prediction alone must not authorize learning. Preserve provenance and conflicting mappings; neither shadow selections nor repeated unconfirmed predictions may reinforce an alias. Exercise this guard through both Telegram and Studio.

## Historical reuse

Add a structured history request to extraction: the operator's reference, requested operation (inspect, compare, or reuse), and any explicit line restriction. Store the selected order/line evidence in application state.

Selecting an order does not itself mean copying every line. Resolve whether the user requested the whole order, particular products, or only a price comparison. After explicit reuse, copy quantities only to the extent requested; validate each product against today's catalogue. Deleted or ambiguous products require clarification. Keep source order number/date visible. Historical prices, discounts, shipping, and VAT do not become defaults; explicit requests to reuse a historical price follow the existing custom-price rules.

## Implementation sequence

Implementation status: phase 1's SDK adapter, strict selection contracts, bounded transport,
product/client projections, configuration, offline tests and fictional read-only evaluation
command are implemented. See `JEV.md`. Workflow activation, independent-question batching,
real-record coverage measurements and phases 2–4 remain pending. `JEV_MODE=on` does not yet
change Telegram or Studio matching.

1. **Foundation and repeatable read-only evaluation.** Add the shared result contracts, injectable TypeSafe SDK adapter, configuration for `off`, `shadow`, and `on`, and explicit read-only connection/evaluation scripts. Unit tests remain offline. The earlier test-registration mismatch has already been fixed. Deliverable: validated Jev requests and reproducible product/client fixtures without changing application decisions; extend fixtures for history in phase 3.
2. **Product and client resolution.** Add candidate construction, Jev selection, alias handling, and application-owned decision evidence. Integrate the resolution step into new and resumed workflows and adapt conversational tools. Preserve form mappings and explicit operator choices. Deliverable: Jev decides product/client identities; ambiguity produces existing clarification UI.
3. **Previous-order selection.** Add paginated scoped retrieval, history request/evidence schemas, Jev order/line selection, and current-catalogue revalidation for reuse. Deliverable: requests can locate older orders and distinguish an incomplete search from no match.
4. **Evaluation and rollout.** Run recorded cases and read-only real-API checks across all three record types, measure candidate coverage and selection errors, then shadow existing decisions before enabling by entity type. Shadow results must not mutate drafts or learn aliases. Rollback is an explicit mode change, not silent per-request fallback.

Primary integration files: `src/assistant/agent.ts`, `src/assistant/extraction-schema.ts`, `src/assistant/workflow.ts`, `src/assistant/customer-order-history.ts`, `src/assistant/system-prompt.ts`, `src/domain/prepare.ts`, `src/connector/contract.ts`, `src/connector/fatture-in-cloud.ts`, `src/connector/demo.ts`, `src/telegram/engine.ts`, `src/telegram/store.ts`, and `src/mastra/index.ts`. Update configuration, environment examples, diagnostics, and evaluation documentation alongside each phase. Keep API transport out of the domain validator by injecting resolution dependencies at composition points.

## Verification and release gates

- Products: exact codes, Italian plurals, synonyms with no shared word, typos, sizes, tester inclusion/exclusion, shipping exclusion, conflicting aliases, discontinued products, and intentional multi-result browsing.
- Clients: legal/trading names, spelling variants, city disambiguation, same names with different VAT numbers, explicit tax-identity conflicts, incomplete billing data, and possible duplicates.
- History: latest order, same-date ties, named date/number, product-content queries, target beyond twenty records, multi-line ambiguity, wrong-client rejection, incomplete pages, empty history, and API failures.
- Workflow: no invented or unverified IDs; no model overriding Jev; unchanged confirmed choices remain stable; revisions invalidate affected evidence; resume and Studio behave consistently; Jev outages ask for clarification; historical values never silently alter pricing; writes still require the existing latest-preview confirmation.
- Transport: malformed answers, unknown candidate keys, timeouts, rate limits, missing credentials, oversized candidate sets, and bounded retries.
- Selection robustness: reorder candidate options to test stability; include irrelevant descriptions and instruction-like API text; keep date ordering and numerical comparisons in code. Test that alias writes require operator-backed selection evidence and cannot learn from shadow results or unconfirmed predictions.
- Measure selection precision, false automatic selections, ambiguity/no-match behavior, retrieval recall, end-to-end latency, and token usage per completed request. Calibrate thresholds separately for products, clients, and orders on held-out cases; confidence alone is not correctness.
- Proposed release gate: zero incorrect automatic selections on the critical regression set, verified clarification on every known ambiguous case, and agreed accuracy/latency targets on held-out realistic examples. Set numerical confidence thresholds only after calibration, not from the eight-case smoke test.

## Evidence from this investigation

- Earlier live API smoke test: HTTP 200; model `jev-1.13.0`; eight of eight synthetic product-selection cases passed. One request took approximately 1.15 seconds and reported 3,127 input tokens and 823 output tokens. This is one observation, not a latency benchmark or an evaluation on business records.
- `npm run check`: passed.
- Earlier targeted investigation baseline: 63 of 64 tests passed; the customer-history tool-registration expectation was stale. Subsequent project work fixed that mismatch and reported 155 passing tests across 26 files, plus passing type checks and build. These checks were not rerun for this documentation-only review and do not validate the proposed Jev integration.
- No live client or historical-order matching evaluation has been run. Catalogue/customer counts and real candidate distributions have not been measured. Those measurements determine batching and retrieval budgets.

## TypeSafe references

- [JavaScript/TypeScript SDK](https://docs.typesafe.ai/sdk/javascript): preferred integration client.
- [Jev 1.13 known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13): option-order sensitivity, numerical/date comparisons, and irrelevant or adversarial context.
- [HTTP API](https://docs.typesafe.ai/api): request/response contracts.
- [Choice](https://docs.typesafe.ai/primitives/choice): bounded record selection, distributions, option limits, and batching.
- [Confidence](https://docs.typesafe.ai/confidence): interpreting distribution concentration.
- [Entity alignment cookbook](https://docs.typesafe.ai/cookbooks/entity_alignment): related record-matching pattern to evaluate where pairwise checks are useful.
