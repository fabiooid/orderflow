# Dated evaluation notes

These are small smoke runs against fictional fixtures. They are not held-out accuracy, a reliability percentage, or a reason to turn a matcher on in production.

## 7 October 2026 — JEV selector smoke

`JEV_MODE=shadow npm run eval:matching`: 20/20 checks passed with `jev-1.13.0`, zero wrong selections and zero unavailable results. Calls took approximately 0.43–1.33 seconds. This does not measure real-catalogue accuracy.

## 7 October 2026 — acceptance conversations

`openai/gpt-5-mini` passed five of six acceptance cases on the first full run. The custom-price case left the customer unresolved. An isolated retry passed, so the precise cause was not established. Existing-customer guidance was clarified, and the next full run passed six of six.

## 8 October 2026 — matching workflow

`JEV_MODE=on npm run eval:matching:workflow`: all 10 smoke cases passed after a repeat run exposed a city/VAT conflict and a deterministic city constraint was added.

## 9 October 2026 — multi-turn conversations

`openai/gpt-5-mini` passed 14 of 14 conversation cases after the prompt and API fixes that run prompted.

## 18 November 2026 — preview-first concise replies (gpt-5-mini, matcher-off)

Fictional `config/example.json`, Node 22, `EVALS_ENABLED=false`, `openai/gpt-5-mini`. `TYPESAFE_API_KEY` absent, so matcher-on was not run. Nothing saved or sent.

Offline: `npm test` 422/422, `npm run check` pass, `npm run boundaries` pass, `eval:acceptance --offline` 7/7.

Live acceptance 7/7 on fields. Some complete drafts still had recap prose; acceptance does not require an empty lead.

Live conversations, five trials each (55 total), empty-lead checks on routine previews:

| Case | Pass |
| --- | --- |
| matched unnamed file | 3/5 |
| unmatched-product unnamed file | 4/5 scored; trial 5 explained the product then also asked to add a customer (detector missed that wording, later tightened) |
| unnamed English new order | 2/5 |
| unnamed Italian new order | 2/5 (two last turns still asked who the client is) |
| apply clear note | 2/5 (notes were `lasciare al banco` on 5/5; failures were recap prose) |
| apply clear quantity | 1/5 |
| apply clear shipping | 3/5 |
| English complete draft | 3/5 |
| unnamed customer change (must ask) | 5/5 |
| missing catalogue combination (must explain) | 5/5 |
| catalogue question mid-order (must answer) | 5/5 |

Overall 35/55. Failures were almost all “draft prepared / review the preview” recaps, plus Italian unnamed last-turn questions about blank client/shipping. Note `nota:` prefix did not reappear in stored notes. This is a small nondeterministic sample, not a reliability percentage. Do not treat as ready for empty-lead production behaviour.

## 24 November 2026 — Haiku vs GPT-5-mini after the customer-source fixes (matcher-off)

Code: main after #84 (customer from the request, `customerRequests`, empty and false-claim retry) and #85 (`readerModel`). Node 22, `MATCHER_MODE=off`, `EVALS_ENABLED=false`. Acceptance and conversations ran against the fictional DemoConnector. Nothing was saved or sent.

| Suite | `anthropic/claude-haiku-5-5` | `openai/gpt-5-mini` |
| --- | --- | --- |
| `eval:acceptance` | 7/7 | 7/7 |
| `eval:conversations` (47 cases, one trial) | 41/47 | 39/47 |
| `eval:orderforms` (one private scanned form, 3 runs) | 0 products read: every page image refused (`image exceeds 10 MB maximum`, about 16 MB sent) | coverage 1.00, 0.92 and 1.00; one wrong certain line in run 3 |

Haiku's conversation misses:

- An unmatched translated product name ("candela" for Linen candle, 2 cases).
- A close customer presented as selected after a failed retry.
- 3 cases of text above the preview.

GPT's misses:

- "saponi" not leading to the hand wash.
- 7 cases of text above the preview.

A focused 4-case × 5-trial comparison on the same code (customer from an attachment, an unnamed new order, a code written with the operator's own wording) gave:

- **Haiku 16/20:** every draft opened, correct customer 10/10, no false draft claims shown.
- **GPT 12/20:** all fields right.

All remaining failures in that comparison were text above the preview.

The deployment uses Haiku for chat with `readerModel: openai/gpt-5-mini`, because Anthropic refuses page images over 10 MB. This is a small nondeterministic sample, not a reliability percentage.
