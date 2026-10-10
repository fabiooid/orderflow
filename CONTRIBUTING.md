# Contributing to OrderFlow

The project is in foundation development and is licensed under the [MIT License](LICENSE). The rules in [ARCHITECTURE.md](ARCHITECTURE.md) are normative.

- Keep invoicing operations in an `OrderConnector`, business decisions in validated configuration, and messaging details in a channel adapter.
- Reuse Mastra workflows, memory, storage, tracing, and evaluation APIs. Check installed types and current documentation before adding replacements.
- Do not add invoice, email, or document-transformation capabilities to this orders-only V1.
- Use fictional examples. Never commit credentials, account exports, PDFs, recordings, customer records, traces, or local databases. Product names, SKUs, prices and VAT numbers in tests must be obviously fictional.
- Test changes with `npm run check` and `npm test`. Add meaningful regression cases for behavior changes, especially tax selection, identity matching, duplicate writes, and order isolation.
- Keep model benchmarks separate from deterministic fixtures. Do not report scripted extraction as LLM accuracy.
- Declare unsupported configurations explicitly. Do not silently introduce business-specific fallbacks.

## How to add a messaging channel

A channel turns a provider's updates into the conversation core and sends replies back. It does not prepare orders.

1. Add a folder under `src/channels/<name>/`. Telegram lives in `src/channels/telegram/`.
2. Implement `ChannelAdapter` from `src/channel/contract.ts`: parse inbound messages and buttons, and send text back. Leave drafts, totals and confirmation in `src/channel/`.
3. Read who may speak, and which conversation to join, from `config.channel`. Do not hardcode a chat id.
4. Call `installInbound` from the process entrypoint (`scripts/` or `src/mastra/`). Core folders must not import the adapter. `npm run boundaries` checks this.
5. Add the adapter to `tests/channel-contract.test.ts`, and document the config keys in `.env.example` and the README.

## How to add an invoicing connector

1. Implement `OrderConnector` in `src/connector/contract.ts` in a new file under `src/connector/`. Map only orders and customers. Do not expose invoices, email or deletes.
2. Keep vendor payload shapes inside the adapter. The domain sees the types in `src/domain/types.ts`.
3. Put provider-only settings under `invoicing` in config (`provider` plus that system's company id). Do not add a new default in code.
4. Add the adapter to `tests/connector-contract.test.ts`. The demo connector is the reference. Mock the vendor HTTP layer; do not call a live account from `npm test`.
5. Wire it from `connectorMode()` / the composition root. `src/domain/` and `src/assistant/` must keep importing the contract only. `npm run boundaries` checks this.
