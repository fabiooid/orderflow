# Contributing to OrderFlow

The project is in foundation development and is licensed under the [MIT License](LICENSE).

- Keep Fatture in Cloud operations in the connector, business decisions in validated configuration/domain policies, and Telegram details in the adapter.
- Reuse Mastra workflows, memory, storage, tracing, and evaluation APIs. Check installed types and current documentation before adding replacements.
- Do not add invoice, email, or document-transformation capabilities to this orders-only V1.
- Use fictional examples. Never commit credentials, account exports, PDFs, recordings, customer records, traces, or local databases.
- Test changes with `npm run check` and `npm test`. Add meaningful regression cases for behavior changes, especially tax selection, identity matching, duplicate writes, and order isolation.
- Keep model benchmarks separate from deterministic fixtures. Do not report scripted extraction as LLM accuracy.
- Declare unsupported configurations explicitly. Do not silently introduce business-specific fallbacks.
