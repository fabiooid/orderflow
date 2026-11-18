# Live conversation 30/39 — cause plan (18 Nov 2026)

Head at investigation: `1994d584`. Full MATCHER_OFF DemoConnector run: **30/39**. Summary named 7; the log has **9 FAIL**. Targeted `attachment-names-known-client` later passed after the newClient→clientQuery merge. Voice-note check already allows stated shipping 8.

Do not treat the missing MATCHER_ON key as the only blocker. These are MATCHER_OFF live failures.

## 39-case accounting

**PASS (30):** caption-names-other-client, caption-client-label, correct-client-after-attachment, prepare-this-but-change-client, change-client-unnamed, cancel-in-words, create-customer-then-edit, customer-already-exists, pick-size-with-button, price-correction, catalogue-question-mid-order, no-copied-template, soap-by-meaning, whole-catalogue, no-invented-delivery, off-topic, new-order-starts-empty, customer-only-does-not-invent-lines, spreadsheet-keeps-named-customer, spreadsheet-create-order-persists-without-tools, spreadsheet-letterhead-is-not-customer, spreadsheet-header-names-customer, cancelled-request-does-not-copy-lines, english-request, missing-combination-offers-alternatives, exact-customer-name-locks, change-customer-on-ready-draft, requested-note-only-from-attachment, requested-english-note-only, no-note-when-not-asked.

**FAIL (9), earliest wrong decision:**

| Case | Kind | Earliest wrong step | After 1994d58 |
| --- | --- | --- | --- |
| attachment-names-known-client | genuine (fixed) | File name stored as `newClient`; resolver would not lock 201 | Merge coerces to `clientQuery` unless they asked to create. Targeted re-run **PASS**. Keep. |
| voice-note-keeps-lines-after-customer | bad assertion (fixed) | Voice stated 8; check required unknown | Check allows 8 **or** an open shipping question. Keep. Correct expectation. |
| show-the-order | genuine | Open draft existed; engine renders Bozza/Anteprima only when a draft tool returns `result` this turn | Application must re-render stored state when the model skips. |
| customer-then-order | genuine | `ok crea ordine` stayed on prepare-customer because email/VAT issues looked blocking | Asking for an order must take over the customer draft (`newClient` carried). Wrong tool or skip both. |
| short-name-on-ready-draft-is-new-search | genuine | search-clients found Northwind; prepare-order never called; 201 stayed | Last client search this turn is identity evidence for an auto prepare-order (empty lines keep products). |
| photo-keeps-lines-and-still-asks-size | genuine | Turn 1 listed the whole catalogue as candidates (uncoded line). Turn 2 `cliente Northwind Bistro` was prose, no prepare-order; client stayed empty | Uncoded candidates = word/related hits, not the catalogue. Labelled `cliente X` / last client search still merge into `clientQuery`. Size conflict and unmatched line stay. |
| weak-customer-stays-unmatched | genuine | Turn 1 search-clients in prose, no draft, so no pendingQuestion. Turn 2 opened a new order without Maple | Client search without prepare-order still opens/keeps that query. Fuzzy singleton stays a question. |
| soap-in-an-order | genuine | MATCHER_OFF `!coded.length` made **every** SKU eligible; Linen candle appeared for `saponi` | Identity candidates for an uncoded query are `matchProducts` / `relatedProducts` / `namedAlternatives` / word-or-related `searchEvidence`. `found=catalogue` is for the agent to judge by meaning, not identity. |
| short-follow-up | mixed | Model confirmed 20× Linen in prose; no prepare-order; engine cannot invent lines from a prior catalogue answer | Tighten: search does not open a draft; call prepare-order the same turn they ask to create/add. Do not script a lucky output. Live remains model-dependent if the model still skips with no lines. |

## Plan (canonical, not per-case scripts)

1. **Engine owns the visible draft.** If an order is open and the model does not call a draft tool, still `prepare-order({})` so the application preview is attached. If this turn recorded a client search, or the operator labelled `cliente`/`customer` + name, send that as `clientQuery` (empty lines keep products). If the open request is a customer and they asked to create an order, call `prepare-order` carrying `newClient` even when the model just called `prepare-customer`.
2. **Search is not identity.** Record `searchEvidence` only for `found=words` or `found=related` (and client search). A catalogue dump is for meaning answers, not candidate ids.
3. **Uncoded lines are not the whole catalogue.** Resolver eligible set = coded hits, word/related/named alternatives, exact/held identities, and recorded search ids. MATCHER_ON still ranks that set; it never silently locks.
4. **Tool copy, not a prompt essay.** Search does not open or change a draft. Missing customer email/VAT does not block starting an order. Call prepare-order the same turn they ask to create or add to an order.
5. **Do not weaken.** Keep Maple unmatched, saponi must not list Linen candle, size question stays, shipping unknown ≠ 0, notes explicit, operator-only save. Voice-note 8 stays allowed because the voice stated it.

Preserve merge/resolver/safe-id behaviour from `1994d58`.

## After implementation (this turn)

Deterministic: `npm run check` pass, `npm test` pass, `npm run boundaries` pass. Live MATCHER_OFF acceptance **7/7**. Live conversations on the first implementation head **37/39**: the original nine failures passed (including short-follow-up). Remaining: `whole-catalogue` (model replied “Ecco i prodotti disponibili:” with no list — truncated copy, not identity) and `new-order-starts-empty` (same skip-prepare-order as short-follow-up, English “add 20 to a new order”). Follow-up: a unique word/related product search plus a stated quantity now opens that line when they ask to create an order. Catalogue dumps still do not invent lines. `whole-catalogue` stays a live listing obligation; do not weaken it.
