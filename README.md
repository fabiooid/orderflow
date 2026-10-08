# OrderFlow

**From conversation to business documents.** OrderFlow turns a Telegram group chat into confirmed sales orders in [Fatture in Cloud](https://www.fattureincloud.it/). It is built with [Mastra](https://mastra.ai) and the official Fatture in Cloud TypeScript SDK.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js >= 22.13](https://img.shields.io/badge/node-%3E%3D22.13-339933)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)
![Status: pre-pilot](https://img.shields.io/badge/status-pre--pilot-orange)

> [!IMPORTANT]
> OrderFlow is an **unofficial** project. It is not affiliated with or endorsed by Fatture in Cloud or TeamSystem. It has not yet been used against a live production account. Read [Project status](#project-status) before you connect real data.

---

## Contents

- [What it does](#what-it-does)
- [Design principles](#design-principles)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Running with Telegram](#running-with-telegram)
- [Scripts](#scripts)
- [Architecture](#architecture)
- [Evaluations](#evaluations)
- [Project status](#project-status)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## What it does

Operators describe an order in plain language in an internal Telegram group, in Italian or English:

> *Due Amber hand wash 250 ml per Example Studio, sconto 10%, spedizione 8 euro*

OrderFlow then:

1. **Extracts** the customer, product lines, discount, delivery and notes into a validated draft.
2. **Matches** products and customers against the live catalogue. If a match is ambiguous or details are missing, it asks follow-up questions.
3. **Applies your business rules**, such as VAT rules, shipping and payment defaults, and computes the totals.
4. **Posts a summary** with a **Conferma e salva** button. Every edit creates a new revision, and buttons from older revisions stop working.
5. **Saves the order** only after explicit confirmation, then sends the order PDF back to the group.

Operators can also send **voice notes**, **photos and screenshots**, **PDFs** and **forwarded customer messages**. Voice notes are transcribed (the transcript is shown with the reply); images and PDFs are read into text before extraction. Media sent without a caption gets a *Preparo un ordine da questo?* question with yes/no buttons, so nothing is read or charged until someone says yes. Several photos sent together as an album are handled as one message. Media files are not stored; only the text read from them is.

It can also create new customers (with duplicate checks) and answer catalogue questions, such as `@your_bot quali varianti di Sapone Zenzero abbiamo?`

The agent can consult a resolved customer's recent orders through the read-only `getCustomerOrderHistory` tool in Telegram and Studio (five orders by default, at most twenty). It uses history to ask better product/size questions and compare past prices, citing the order number and date. Previous prices and discounts never become automatic defaults. A failed lookup is reported as unavailable rather than as an empty order history.

## Design principles

- **Orders only.** The public connector and agent tools contain no invoice, proforma, customer-email, document-conversion or delete operations. Configuration cannot turn them on.
- **Nothing is written without a human.** Saves need explicit confirmation of the latest revision. Demo and Studio entry points never write.
- **No guessing.** If a VAT case matches no rule, a product match is ambiguous or a VAT number is unvalidated, the order pauses for review. No tax rate is assumed by default.
- **Duplicate-safe writes.** A durable write journal returns the stored result on replay and stops for manual reconciliation when an outcome is uncertain. It never retries blindly.
- **Configuration over code.** Company IDs, VAT rules, required customer fields, the model and the Telegram group all live in a validated JSON file. The code contains no business-specific defaults.

## Quick start

**Requirements:** Node.js ≥ 22.13 and npm.

```bash
git clone https://github.com/fabiooid/orderflow.git
cd orderflow
npm ci
```

Check that everything works offline. No credentials are needed:

```bash
npm run check   # TypeScript
npm test        # Vitest suite (fictional fixtures, simulated APIs)
npm run demo    # scripted end-to-end run against a fictional catalogue
```

`npm run demo` uses scripted extraction and simulated API responses. It shows the orchestration and duplicate protection, but it says **nothing about LLM accuracy**. Its temporary databases are removed when it finishes.

### Order forms and price tiers

Customers often send back a printed price list with quantities written next to each product. OrderFlow reads those against a **template** of the form: its printed rows, the columns customers write in (a number, or a mark such as an X), and the product each cell orders. The model only says what is written in which row and column; the products come from the template, so the form's meaning lives in data you review, not in code:

```bash
npm run orderform:import -- path/to/clean-price-list.pdf --id my-form            # writes private/order-forms/my-form.json
npm run orderform:import -- path/to/trade-list.pdf --id trade --tier trade        # prices on this form are the "trade" tier's
npm run pricetier:suggest -- --tier trade                                        # clients whose past orders used those prices
```

The import maps each fill-in cell to a catalogue product using printed codes and the form's own printed notes. Review each generated file, then list it in your business config under `orderForms` (paths are fine) and add a `priceTiers` entry with the client IDs you agree with. Both scripts are read-only. Templates describe your business, so keep them out of git (`private/` is ignored). When the printed form changes, import it again.

When a photo or scan arrives, OrderFlow turns it upright, recognises the form, enlarges small scans and reads it **twice** at full image detail. The two readings are compared by product, so a mark read on a neighbouring cell that orders the same product still agrees; quantities both readings agree on are used, and every disagreement becomes a question. Low-resolution scans produce more questions and occasionally a shared misreading: ask customers for phone photos or scans of at least 150 dpi, and check form orders against the paper. `npm run eval:orderforms` measures this on forms whose correct order you know (see [EVALS.md](EVALS.md)). Reading takes about a minute per page, with "typing…" shown meanwhile.

Clients in a tier get the tier's prices; a product without a tier price is asked about, never guessed. The order summary names the price list in use and, under **⚠️ Da verificare**, lists prices that differ from the client's previous orders. Those are pointed out only: nothing is changed and saving is not blocked.

### Alias learning

Operators can teach product names and shop/business-name aliases in ordinary messages. The agent's `rememberAlias` tool verifies that the target exists, records the exact operator quote and identity, and persists the mapping in Mastra resource-scoped working memory. Shared Telegram routing and new order threads use the same resource; older order threads retain their history and searches still consult shared aliases. There are no aliases embedded in the source code.

Learning requires an explicit correction or teaching statement, not merely order confirmation. Attachments and forwarded text cannot authorize learning. Conflicting mappings remain candidates for clarification; operators can explicitly ask to forget a mapping. Prices, tax rules and delivery defaults are not learned. Recognizing a teaching statement is model behavior, so review early learning traces during the pilot.

### Try the assistant in Mastra Studio

```bash
cp .env.example .env    # then set OPENAI_API_KEY (or your model provider's key)
npm run dev
```

Studio follows `CONNECTOR_MODE`:

| Mode | Data source | Writes |
| --- | --- | --- |
| `demo` (default) | Fictional catalogue | None |
| `read-only` | Your Fatture in Cloud account | None |

Model calls may incur provider charges. **Keep Studio local.** It has no authentication, and its traces contain conversation data.

## Configuration

Settings come from two places:

**1. Environment (`.env`)**, for secrets and runtime switches. See [`.env.example`](.env.example).

| Variable | Purpose |
| --- | --- |
| `APP_CONFIG_PATH` | Path to the business configuration JSON |
| `CONNECTOR_MODE` | `demo` or `read-only` |
| `OPENAI_API_KEY` | Key for the configured model provider (needed for live model calls only) |
| `FIC_ACCESS_TOKEN` | Fatture in Cloud API token |
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather |
| `EVALS_ENABLED`, `EVALS_SAMPLE_RATE`, `EVAL_JUDGE_MODEL` | Background evaluation settings |
| `MASTRA_DATABASE_URL` | Mastra storage location for demo mode |

**2. Business configuration (JSON)**, for company, Telegram group, VAT rules, shipping, required customer fields, model and memory. Start from the fictional [`config/example.json`](config/example.json):

```bash
cp config/example.json config/business.local.json
# edit it, then set APP_CONFIG_PATH=config/business.local.json in .env
npm run config:check -- config/business.local.json
```

The validator checks:

- the structure
- supported pricing and currency (net B2B pricing only)
- duplicate rule IDs
- overlapping VAT rules without an explicit priority

It does **not** contact Fatture in Cloud. Remote IDs are verified by `npm run connections:check`.

Notes:

- Product, VAT and payment IDs are **API IDs**, not product codes or printed document numbers.
- Country conditions are explicit ISO lists. EU membership is never inferred.
- Product matching uses names, attributes and optional codes. An exact normalized match wins; otherwise every query term must match, and several matches produce a choice.
- `transcription.model` (optional, e.g. `openai/gpt-4o-mini-transcribe`) enables voice notes and uses `OPENAI_API_KEY`. Without it, voice notes get a "not enabled" reply. Images and PDFs are read with `model`, which must accept images.
- `orderSavingEnabled` (default `false`) must be set explicitly before a deployment can save orders.
- `*.local.json`, `.env`, `.data/` and database files are git-ignored. Keep them that way.

## Running with Telegram

The runner uses **long polling**, so you need no public URL, webhook or hosting to test locally. The full walkthrough is in **[CONNECTIONS.md](CONNECTIONS.md)**. In short:

```bash
npm run telegram:discover     # find your group ID (send a message to the bot first)
npm run connections:check     # read-only checks of bot, group, company, catalogue, VAT
npm run telegram:commands     # register the Italian command menu for the group
npm run telegram:start        # start the poller (Ctrl+C to stop gracefully)
```

Talk to the bot naturally in the configured group. The group has one active request at a time; finish or cancel it before you start another. Slash commands are optional shortcuts:

| Command | Alias | Action |
| --- | --- | --- |
| `/ordine` | `/order` | Start preparing an order |
| `/cliente` | `/customer` | Start creating a customer |
| `/confermaordine` | `/confirmorder` | Save the latest order summary (reply to it) |
| `/confermacliente` | `/confirmcustomer` | Create the latest customer (reply to it) |
| `/annulla` | — | Cancel the unsaved request |

**Token permissions:** give the Fatture in Cloud token read access to products, clients and settings, plus order-only document access. **Do not grant invoice permissions.** The application's own restrictions are a second layer, not a substitute for a scoped token.

**If a delivery is uncertain** (for example, Telegram timed out), the poller stops instead of resending. Check the group, then run `npm run telegram:recover`. CONNECTIONS.md describes the steps.

## Scripts

| Script | Description |
| --- | --- |
| `npm run check` | Type-check with `tsc --noEmit` |
| `npm test` | Run the offline Vitest suite |
| `npm run demo` | Scripted end-to-end demo with fictional data |
| `npm run dev` / `build` | Mastra Studio dev server / production build |
| `npm run config:check` | Validate a business configuration file |
| `npm run connections:check` | Read-only diagnostics of Telegram and Fatture in Cloud access |
| `npm run model:check` | Send a tiny live model request to test connectivity (may cost money) |
| `npm run telegram:start` | Start the Telegram long-polling runner |
| `npm run telegram:discover` | List candidate group IDs from pending updates |
| `npm run telegram:commands` | Register the bot command menu for the group |
| `npm run telegram:recover` | Reconcile an uncertain message delivery |
| `npm run telegram:pdf` | Send an **existing** order's PDF to the group |
| `npm run telegram:traces:import` | Import historical transport records into Mastra traces |

## Architecture

```
Telegram group ──► src/telegram ──► src/assistant (Mastra agent + workflows)
                                         │
                                         ├─► src/domain     matching, VAT, totals
                                         ├─► src/config     validated business config
                                         ├─► src/storage    write journal
                                         ▼
                                    src/connector ──► Fatture in Cloud SDK
```

| Module | Responsibility |
| --- | --- |
| [`src/connector`](src/connector) | Narrow, orders-only contract over the official SDK, plus a fictional demo connector. Depends on neither Mastra nor Telegram. |
| [`src/domain`](src/domain) | Typed drafts, product matching, business preparation, totals |
| [`src/config`](src/config) | Public configuration schema and loader |
| [`src/assistant`](src/assistant) | Mastra agent, `prepare-order` suspend/resume workflow, customer-creation skill, scorers, journaled saves |
| [`src/telegram`](src/telegram) | Bot API transport, polling controller, routing, previews, delivery recovery |
| [`src/storage`](src/storage) | Application write journal. Mastra owns conversation and workflow storage. |
| [`src/health`](src/health) | Read-only diagnostic checks |
| [`src/mastra`](src/mastra) | Studio registration and local trace exporter |

Each group has one shared Mastra conversation, stored with speaker IDs and a bounded history. Prices, VAT, permissions and saved-order state always come from the application and the API, never from model memory.

## Evaluations

Six Mastra scorers are included:

- tool-call accuracy
- workflow adherence
- conciseness
- language consistency
- context retention
- user-reported mistakes

They run in the background on model runs and on delivered Telegram replies, and they never affect saves or replies. Set `EVALS_ENABLED=false` to score manually only. See **[EVALS.md](EVALS.md)** for what each score means and its limits.

## Project status

OrderFlow is in **foundation / pre-pilot** stage.

**Working and covered by offline tests**

- [x] Natural-language order and customer preparation in a shared Telegram group
- [x] Revision-bound confirmation buttons and commands
- [x] Order saving with PDF delivery, and customer creation with duplicate checks
- [x] Duplicate-safe write journal and uncertain-delivery recovery
- [x] Configurable VAT rules, including manual VIES confirmation
- [x] Background evaluation scorers

**Not yet done**

- [ ] First confirmed order against a live account (user acceptance testing)
- [ ] Voice-note and image input
- [ ] Approved-alias management and automatic learning
- [ ] Remote-write reconciliation tooling and automatic recovery of failed PDF deliveries
- [ ] Shipping notes for existing customers
- [ ] Editing orders after they are saved (handled manually in Fatture in Cloud for now)
- [ ] Live-model accuracy evaluation
- [ ] Hosting, plus authentication for a deployed server

Offline tests use fictional data and injected transports. **They do not show live-model accuracy or prove behavior against a real account.** The longer-term design is in [IMPLEMENTATION-PROPOSAL.md](IMPLEMENTATION-PROPOSAL.md).

## Contributing

Contributions are welcome. Please read **[CONTRIBUTING.md](CONTRIBUTING.md)** first. The key rules:

- Respect the module boundaries and the orders-only scope.
- Use only fictional data. Never commit credentials, PDFs, customer records, traces or databases.
- Run `npm run check` and `npm test`, and add regression tests when you change behavior.

## Security

Please **do not open public issues for security problems.** Report them privately through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository.

Never paste tokens into Telegram, issues or pull requests.

## License

[MIT](LICENSE) © 2026 Fabio Vella. Third-party dependencies keep their own licenses.

*Fatture in Cloud is a trademark of its respective owner. It is used here only to describe compatibility.*
