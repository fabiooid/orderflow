# ADR 0001: Independent document reading with replaceable providers

Date: 2026-10-08
Status: Accepted; first implementation complete, provider benchmark pending.

## Context

Operators send scanned PDFs, photographs and scanner image files. Their resolution,
orientation and handwriting vary. Reading documents is a different responsibility
from interpreting an order, resolving catalogue products and calling Fatture in Cloud.
The previous media path combined Telegram downloads, template recognition, catalogue
lookups and text formatting. PDF preprocessing also depended on template configuration.

## Decision

Use an in-process `src/documents` module with a `DocumentProvider` interface. Keep the
existing direct-vision approach as the first provider (`direct-vision-v1`). Do not
introduce a separate deployment or product now. A remote implementation can use the
same interface if independent scaling, reuse or operational isolation later warrants it.

The flow is:

1. The transport downloads attachments and supplies bytes plus a MIME hint.
2. The document provider validates and normalizes files, renders pages, recognizes
   optional templates and reads visible content.
3. It returns page-indexed observations: text, a template identifier, and both raw
   row/column readings. It does not return catalogue product IDs or create orders.
4. The OrderFlow adapter maps template cells to products using business configuration,
   compares the two readings, and formats data for order interpretation.
5. Existing validation, operator confirmation and save logic remain responsible for
   business decisions and external writes.

Template hints contain only printed headings, row codes/labels and column types.
Product IDs, template price bindings and live catalogue access remain outside the
reader. Model providers receive document content as untrusted data, not instructions.

## First implementation

- `contract.ts`: file, template, observation and provider contracts.
- `reader.ts`: direct-vision provider and content-based PDF/image decoding.
- `templates.ts`: orientation, template identification and raw cell reading.
- `workflow.ts`: Mastra identify/two-read/collect workflow, with snapshots disabled.
- `vision.ts`: model adapters and transcription prompts, including output-limit checks.
- `pdf-pages.ts`: complete-page PDF rendering, moved out of Telegram.
- `telegram/order-forms.ts`: business mapping and legacy order-form evaluation wrapper.
- `telegram/media.ts`: download, voice handling, localization and order text assembly.

The production Telegram path uses the new provider. The existing order-form evaluation
workflow remains available and shares the extracted recognition/cell-reading primitives.

Every accepted PDF now goes through complete-page rendering, even without templates.
General transcription runs per page to preserve provenance, so call count and latency
can increase compared with the previous batched reader. Template identification also
runs without configured templates in production to retain orientation handling.

The baseline accepts PDF, JPEG, PNG, WebP, static GIF and TIFF. Multi-page TIFF is
expanded into pages. Decoding checks actual bytes rather than trusting MIME hints.
Limits are 20 MiB per file, ten pages per request and 40 million decoded pixels per
image page. All input pages are validated before model calls. Animated images fail
explicitly. Telegram's MIME filter now admits TIFF; it still filters other unsupported
or missing MIME types before downloading them.

Existing PDF rendering scale (at most 2x, longest edge at most 2400 pixels), small-scan
enlargement and high-detail model settings are retained for this baseline. Normalized
images are not reduced to 2048 pixels locally before general transcription anymore.
The 8000-character transport reading limit still rejects overlong results rather than
silently truncating them. Model output stopped at its length limit is rejected.

## Reliability semantics and remaining work

All document results currently have `status: needs_review`. It is deliberately not a
claim of measured confidence. Two matching calls can share the same mistake or omit
the same row. The business adapter's legacy `sure` label means agreement only; it is
retained for compatibility with the existing draft flow and scorers.

This change establishes a boundary, not an accuracy certification. The following are
not implemented yet:

- Explicit blank/unreadable/value cell states; nullable quantities retain legacy meaning.
- Blur, skew, clipped-content or missing-page detection and a calibrated rescan gate.
- Bounding boxes, crop-based retries and higher-resolution PDF rendering experiments.
- Structured field extraction for unknown documents; general content remains page text.
- HEIC/BMP conversion and explicit transport responses for every unsupported MIME type.
- Retained source images or a visual review UI. Page references and raw readings exist
  in the service result, but the Telegram draft still consumes formatted text. Media
  bytes remain excluded from stored traces and workflow snapshots.
- A second OCR provider, comparative benchmark results or automatic provider fallback.

Upscaling cannot recover missing detail. Prefer requesting a clearer scan when evidence
is insufficient. Do not interpret a model's self-reported confidence as a calibrated
probability. Keep order confirmation in place regardless of provider.

## Provider benchmark plan

Benchmark the direct-vision provider against Azure Document Intelligence first. Azure's
layout/text/table/selection-mark output is relevant to these printed forms. Google
Document AI is another candidate, especially for its document-quality analysis.
Neither is assumed to outperform direct vision on our handwriting without measurements.

Use a private, human-labelled corpus of representative operator documents (suggested
initial target: 30–50 documents). Include clean and poor scans, handwriting, rotated
pages, unknown forms, multi-page documents, JPEG/PNG/TIFF and image-only/mixed PDFs.
Label every ordered row and quantity, customer/delivery details, and genuinely
unreadable regions. Keep documents and customer data out of Git.

Run each candidate on the same held-out documents; repeat vision runs to measure
variability. Freeze templates, model/provider versions and preprocessing settings.
Record:

- Incorrect quantities/products accepted without clarification, per document and line.
- Missed ordered rows, separate from explicitly flagged uncertainties.
- Exact quantities and customer/delivery field accuracy.
- Operator corrections, clarification rate and rescan rate.
- End-to-end latency, provider calls and actual cost per document.

Existing `npm run eval:orderforms -- private/evals/order-forms.json --runs 3` supplies
product-level agreement precision and coverage for the current template reader. It does
not benchmark the full new provider or customer details; extend the evaluation harness
at the new provider boundary when adding Azure. Offline fixtures test behavior, not OCR
accuracy. Do not run a vendor comparison or claim a winner until the corpus, credentials
and candidate implementation are available.

Prefer the simplest provider meeting agreed error/review targets. Adopt OCR plus an LLM
only if measured reductions in silent errors or operator effort justify added latency,
cost and maintenance. Check deployment region and data-retention settings before sending
real customer scans to a new vendor.

## References considered

- OpenAI vision capabilities and limitations: https://developers.openai.com/api/docs/guides/images-vision
- OpenAI PDF inputs: https://developers.openai.com/api/docs/guides/file-inputs
- Azure Document Intelligence layout: https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0
- Google Enterprise Document OCR: https://docs.cloud.google.com/document-ai/docs/enterprise-document-ocr
- Textract quality guidance: https://docs.aws.amazon.com/textract/latest/dg/textract-best-practices.html
