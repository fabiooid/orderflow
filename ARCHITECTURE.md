# Architecture rules

OrderFlow is a reusable orders assistant. Business facts and vendor clients stay outside the core.

## No business data in the repo

Product names, SKUs, prices, customer names, VAT numbers, addresses and shop wording belong in the operator's own config or in clearly fictional fixtures. Do not commit a real catalogue, a real order, or a prompt written for one shop.

Product, customer and order ids are opaque strings in the domain and on `OrderConnector`. An adapter converts its own id type at the boundary. Fatture in Cloud keeps numeric ids inside `src/connector/fatture-in-cloud.ts`.

Italian e-invoicing is optional. SDI and PEC country lists live under `tax.italy` and are omitted when a deployment does not collect them. VAT type ids, nature codes and the shipping product id live in the invoicing provider block, not in the generic VAT rules.

## Adapters behind interfaces

- Invoicing reads and writes go through `OrderConnector` in `src/connector/contract.ts`. Fatture in Cloud is `src/connector/fatture-in-cloud.ts`. Its company id and display name live under `invoicing` in config. `src/domain/` and `src/assistant/` do not import a vendor SDK.
- Document reading goes through `DocumentProvider` in `src/documents/contract.ts`.
- A messaging channel implements `ChannelAdapter` in `src/channel/contract.ts`. Telegram is `src/channels/telegram/`. Conversation state, previews and confirmation live in `src/channel/` and must not import an adapter.
- Adding a channel or an invoicing backend is a new adapter folder plus config. It does not edit order preparation, totals or the confirmation flow.
- The demo connector and the contract tests are the reference a new adapter must pass.

## Locale and currency

Operator-facing language and currency come from config. Italian and English wording lives in `src/channel/locales/`. Do not hardcode a shop's currency symbol or a single language in core logic. Supported languages today are Italian and English (`locale: "it" | "en"`). `currency` is an ISO 4217 code from config, not a fixed `EUR`.

## What core must not import

Core folders (`src/domain`, `src/assistant`, `src/documents`, `src/channel`) must not import a specific channel package or `src/connector/fatture-in-cloud.ts`. `npm run boundaries` fails the build if they do. Composition roots (`src/mastra`, `src/health`, `scripts/`) may wire an adapter.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add an adapter.
