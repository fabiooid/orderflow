# Contributing to OrderFlow

The project is in foundation development and is licensed under the [MIT License](LICENSE). The rules in [ARCHITECTURE.md](ARCHITECTURE.md) are normative.

- Keep invoicing operations in an `OrderConnector`, business decisions in validated configuration, and messaging details in a channel adapter.
- Reuse Mastra workflows, memory, storage, tracing, and evaluation APIs. Check installed types and current documentation before adding replacements.
- Do not add invoice, email, or document-transformation capabilities to this orders-only V1.
- Use fictional examples. Never commit credentials, account exports, PDFs, recordings, customer records, traces, or local databases. Product names, SKUs, prices and VAT numbers in tests must be obviously fictional.
- Test changes with `npm run check` and `npm test`. Add meaningful regression cases for behavior changes, especially tax selection, identity matching, duplicate writes, and order isolation.
- Keep one stored draft per request and one identity-resolution pass. `prepare-order` merges attachment facts and model edits into that draft, then the resolver accepts supported exact identities or keeps real candidates. Uncoded identity candidates are word or related hits, not the whole catalogue; a `search-products` catalogue dump is not identity evidence. The application re-renders an open order when the model skips a draft tool, cancels when they ask to drop it, and a request to create an order takes over an open customer draft. `prepareOrder` is commercial completeness only: it must not rematch products or customers. The matcher ranks or proposes; it never silently confirms a fuzzy singleton. Unique SKUs need current-request evidence plus a real catalogue row. Tester marks select the tester catalogue product, never the sale SKU.
- Keep model benchmarks separate from deterministic fixtures. Do not report scripted extraction as LLM accuracy.
- Declare unsupported configurations explicitly. Do not silently introduce business-specific fallbacks.

## How to add a messaging channel

A channel turns a provider's updates into the conversation core and sends replies back. It does not prepare orders.

1. Add a folder under `src/channels/<name>/`. Telegram lives in `src/channels/telegram/`.
2. Implement `ChannelAdapter` from `src/channel/contract.ts`: parse inbound messages and buttons, and send text back. Leave drafts, totals and confirmation in `src/channel/`. Map inbound files to the attachment kinds the core can use (voice, image, PDF, spreadsheet). If the operator sends a file you cannot map, still return a `MessageEvent` with `unusableAttachment: true`, even when there is no caption. Returning `null` for that file makes the bot stay silent; the core replies that the file could not be used and leaves any open draft unchanged.
3. Read who may speak, and which conversation to join, from `config.channel`. Do not hardcode a chat id.
4. Call `installInbound` from the process entrypoint (`scripts/` or `src/mastra/`). Core folders must not import the adapter. `npm run boundaries` checks this.
5. Add the adapter to `tests/channel-contract.test.ts`, and document the config keys in `.env.example` and the README.

## How to add an invoicing connector

1. Implement `OrderConnector` in `src/connector/contract.ts` in a new file under `src/connector/`. Map only orders and customers. Do not expose invoices, email or deletes.
2. Keep vendor payload shapes inside the adapter. The domain sees the types in `src/domain/types.ts`.
3. Put provider-only settings under `invoicing` in config (`provider` plus that system's company id). Do not add a new default in code.
4. Add the adapter to `tests/connector-contract.test.ts`. The demo connector is the reference. Mock the vendor HTTP layer; do not call a live account from `npm test`.
5. Wire it from `connectorMode()` / the composition root. `src/domain/` and `src/assistant/` must keep importing the contract only. `npm run boundaries` checks this.

## How to add an attachment or input type

Photos, voice notes, PDFs and spreadsheets are generic inputs. They become text or facts for the existing draft and matching flow. They are not shop-specific forms.

1. Admit the file at the channel boundary (`src/channels/<name>/`) by MIME type and filename so it is not dropped before reading. Files that still cannot be mapped must return `unusableAttachment: true`, not `null`. Core folders must not import the adapter.
2. Decode bytes in `src/documents` by content, not by a shop layout, sheet name or column heading. Return page text or labelled facts (product code, quantity, tester marks, a customer name found in a header). Supplier letterhead is not a customer. Do not resolve catalogue IDs or write orders here.
3. Reuse `createMediaReader`: wrap the reading in the same attachment block as photos and PDFs, keep it apart from `operatorWords`, and let the canonical merge plus the identity pass consume the decoded lines. Empty `prepare-order` lines keep rows already on this request, including attachment facts. Catalogue prices apply until the operator confirms a price from the file. Printed kit-content sizes in an attachment are not variant constraints.
4. Cover it with fictional fixtures only. Add a short note here and in the README when a new input type is accepted. Use `npm run check`, `npm test` and `npm run boundaries`.

## How to add a matcher

1. Implement `SelectMany` from `src/matching/resolver.ts`. Map only identity choices. Do not write orders or customers from the matcher.
2. Keep the vendor client inside the adapter. `src/matching/resolver.ts` and `src/matching/client-search.ts` must not import it.
3. Install it from a composition root (`src/mastra/`, `scripts/`, `src/evals/`) by passing `selectMany` into `createIdentityResolver` or `wireMatching`. `MATCHER_MODE=off` (and the deprecated `JEV_MODE=off`) must keep working with no matcher installed.
4. Cover it with the existing resolver tests by passing your function as `selectMany`. Do not call a live account from `npm test`.
