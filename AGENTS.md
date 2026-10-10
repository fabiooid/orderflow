# Agent rules for OrderFlow

Read [ARCHITECTURE.md](ARCHITECTURE.md) before editing.

- Keep the project a generic MIT orders tool. No shop catalogue, customer records, prices, VAT numbers or one-business prompts in code, tests, fixtures or docs.
- If a string might be a real customer, product or address, replace it with fictional data or ask. Do not guess.
- Do not import Telegram, Fatture in Cloud, or another vendor SDK from `src/domain/`, `src/assistant/` or `src/documents/`. Use `OrderConnector` and the document provider.
- A new messaging channel or invoicing backend is a new adapter plus config. Do not fold it into order preparation or the confirmation flow.
- Language and currency come from config. Operator copy is in `src/channel/locales/`. Currency is an ISO 4217 code, not a fixed EUR.
- Product, customer and order ids are opaque strings. Convert a provider's numeric ids only inside that provider's adapter. SDI and PEC country lists belong in optional `tax.italy`. VAT type ids, nature codes and the shipping product id belong in the invoicing provider block.
- Keep current behaviour. Run `npm run check` and `npm test`. Do not weaken a test to force a pass.
- Do not commit secrets, `.env` files, or `private/` data.
