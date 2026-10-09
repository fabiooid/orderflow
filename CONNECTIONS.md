# Connect and verify OrderFlow

This milestone supports Telegram text conversations with either a fictional catalogue or **read-only** Fatture in Cloud data. It does not save real orders. Credential checks alone do not establish correctness: finish with a representative conversation and inspect the result.

## 1. Local settings

If you do not already have local settings, copy `.env.example` to `.env` and `config/example.json` to `config/business.local.json`. Set `APP_CONFIG_PATH=config/business.local.json` in `.env`. Preserve existing files if they are already configured.

Enter secrets directly in the local `.env` file, not in chat:

- `TELEGRAM_BOT_TOKEN`: obtain from Telegram's BotFather.
- `FIC_ACCESS_TOKEN`: an API token for the intended Fatture in Cloud company.
- The provider key for your configured model; the example uses `OPENAI_API_KEY`.

Set your company ID and Telegram group ID in the local JSON configuration. Product, VAT and payment method IDs are API IDs, not product codes, names or printed document numbers. Keep `priceBasis` as `net` and configure your own VAT rules. The public example is fictional and not approved tax guidance.

For the account token, plan for products read access, client access, order-only document access and read-only configuration as required. **Do not grant invoice permissions.** The checker does not prove absence of invoice rights and never attempts an invoice request. Order writes remain disabled by this runtime even if the token permits them.

## 2. Find the Telegram group

Create a dedicated internal group and add the bot and the operators. The bot must be allowed to send text and documents. Administrator status is not required when ordinary group permissions allow this.

With other pollers stopped, mention the bot in the group (for example `@YOUR_BOT_USERNAME ciao`), then run:

```sh
npm run telegram:discover
```

Copy the intended group ID into `telegram.groupId`. Discovery lists group names/IDs from pending messages but does not send messages or acknowledge updates. If a webhook exists, do not replace it automatically: use a dedicated bot or deliberately remove the previous integration yourself.

Privacy mode can remain enabled: mention the bot to start, and **reply to the bot's latest message** for follow-ups (with an open request, plain messages reach the bot too). To have the bot read every message, disable privacy mode with BotFather and set `respondToAllMessages: true`. Unrelated messages are ignored. Any human group member can contribute; anonymous sender identities and other bots are ignored.

With privacy mode enabled, the bot never receives photos, voice notes or forwarded messages sent on their own, only those that reply to it or mention it in a caption. To let operators drop media straight into the group, turn privacy off in BotFather (`/setprivacy`) or make the bot an administrator, then remove the bot from the group and add it again. `connections:check` reports this as `MANUAL` while privacy mode hides messages.

## 3. Read-only diagnostics

```sh
npm run config:check -- config/business.local.json
npm run connections:check
```

The connection checker reads bot/group membership and send permissions, webhook status, company access, catalogue and shipping product, clients, VAT rates/nature codes and an explicitly configured payment method. It prints counts/statuses, not client records or credentials. It sends no messages, acknowledges no Telegram updates, and performs no document writes.

`PASS` means that specific read check succeeded. `FAIL` means it must be fixed. `MANUAL` identifies evidence the checker cannot establish: order-write scope, invoice exclusion, API plan/write quota, unresolved payment defaults, and model behavior. A zero exit code means no automated failures, **not permission to enable writes**.

A separate explicit probe makes a tiny model request, which may incur provider charges:

```sh
npm run model:check
```

This verifies only model connectivity, not transcription or order accuracy.

## 4. Telegram demo, then real-data preview

Use `CONNECTOR_MODE=demo` with the example product and tax settings to start against the fictional catalogue. Use your actual Telegram group ID and model key even in demo mode:

```sh
npm run telegram:start
```

Example input: `@YOUR_BOT_USERNAME order two Amber hand wash 250 ml for Example Studio, 10% discount, delivery 8 euros`.

Ask for “Amber 250” to exercise variant clarification: pick the variant with its button, then give the delivery charge. A colleague can answer too. Starting a second request while one is open lists the open requests with a cancel button. In preview mode the **👀 Segna come controllato** button marks a complete preview reviewed; replying with changes reopens it. Replies to an older revision are rejected.

Then set `CONNECTOR_MODE=read-only`, restore the real account mappings, run the checks, and restart the runner. It uses the real catalogue and client data but **never creates or modifies records**. It returns a clearly labelled preview, not a saved-order claim or a fabricated PDF.

The runner uses long polling: no public URL, tunnel, webhook server or hosting purchase is needed for this local test. One process handles updates sequentially. Its database, poll offset and message links persist under `.data/`. Demo and account conversations are separated. Changing configuration causes old conversations to require a fresh order.

Stop with Ctrl+C. Shutdown waits for the current poll/operation to finish. Do not run two copies for the same bot or expose Mastra Studio publicly.

## 5. Test a real order PDF without creating an order

Once account access is verified, explicitly post an **existing order** PDF to the configured internal group:

```sh
npm run telegram:pdf -- --order DOCUMENT_ID
```

Use the API document ID, not its printed order number. The command reads the order, rejects non-order documents, retrieves its current PDF URL and sends an attachment to the configured group. It does not create/update orders or email customers. Inspect Telegram before retrying if delivery is not confirmed. This command is an explicit sending action; `connections:check` never invokes it.

Saved orders are not updated automatically; post-save changes are made manually in Fatture in Cloud.

## Failure and restart checks

Update IDs are deduplicated. Plans are persisted before sending; successful replays do not call the model or send another response. A timeout during Telegram delivery leaves an uncertain send and stops the poller. Do not automatically resend because Telegram may already have received it.

After inspecting the group and stopping the poller, reconcile the update shown in the error:

```sh
npm run telegram:recover -- UPDATE_ID delivered MESSAGE_ID
```

If you have verified the message was not delivered:

```sh
npm run telegram:recover -- UPDATE_ID not-delivered
```

Recovery changes only local delivery state. Restart the runner to continue. Group supergroup message links end with their message ID. For groups where this is unavailable, inspect the Bot API result/logging locally before choosing recovery; never guess an ID.

The local poller lock prevents a second process. A lock from an exited process can be reclaimed; do not delete `.data/` to fix uncertain remote outcomes. A crash during an agent turn may rerun read/model work, but no remote order writes occur in these modes.

## Verification performed without credentials

Automated tests use fictional records, injected transports and a scripted stand-in for the agent. They cover read-only health checks, secret redaction, PDF transport, group restrictions, interleaved orders, stale buttons, candidate picks, duplicate updates and uncertain-delivery recovery. They do not claim a successful live Telegram, model or Fatture in Cloud session.

### Manual VIES checks and Telegram traces

EU rules with `requireValidVat` pause until a manual VIES result is supplied (or an injected validator returns valid). The structured draft stores the checked country, VAT number and result. A confirmation for a different VAT identity cannot unlock the order. The agent must only record an explicit operator confirmation; validate this with live conversation evaluations before enabling saves.

The Telegram engine now exports Mastra traces into its own persistent LibSQL storage (`.data/telegram-<deploymentId>-<mode>.db`). Studio in read-only mode uses this same database so Telegram traces and threads are visible; demo mode remains separate. Existing live agent traces have been verified in storage.

Fatture in Cloud's default VAT entry may have ID `0`; this is supported. Account nature values such as `3.2` are compared against configured `N3.2` after normalization.

### Customer creation from Telegram

In account (`CONNECTOR_MODE=read-only`) mode, ask the bot to create a customer (for example “crea il cliente Bottega Verde, Via Roma 1, Bergamo”). Press **✅ Conferma e salva** under the latest customer summary to authorize creation. This is the sole enabled write in this mode; order creation and updates remain disabled. Required customer fields are deployment-configured and still apply to test records. No fake VAT or SDI identifiers are generated. Duplicate names or VAT numbers return existing records instead of creating another.

Customer writes use `.data/customer-writes.db` for durable retry protection. If a write is uncertain, stop and reconcile the customer in Fatture in Cloud before retrying; do not start another request to bypass the journal. No customer emails are sent. Demo mode cannot create real customers.


### Natural catalogue questions

Mention the configured bot in the approved group, for example `@your_bot quali varianti di Sapone Zenzero abbiamo?`. The shared Mastra agent answers using product-search tools and conversation memory. Reply to its answer for follow-up questions. Unaddressed group chatter remains ignored. Answering a question never changes the open request; orders and customers are saved only with their confirmation buttons. Product search returns names, codes, descriptions and net prices to the configured model provider.

There are no slash commands: write to the bot naturally, and confirm with the buttons under the latest summary.

### Telegram message traces

Open Studio in read-only mode and use its Traces view. Agent traces contain actual model/tool activity. Separate Telegram message traces contain incoming text, planned replies, conversation/update IDs and delivery status. They are correlated by conversation ID, not nested under model traces. These local records contain customer data; keep Studio private.

`npm run telegram:traces:import` imports existing transport records without calling Telegram or the model. Historical records are explicitly labelled; missing input and original timing are not invented. Deterministic trace IDs prevent duplicate imports. Previously ignored or unretained messages cannot be reconstructed. Restart Studio after changing its storage configuration.


### Confirmed order saving

Set `orderSavingEnabled: true` for an account deployment to enable the **✅ Conferma e salva** button on order summaries. Ask for an order, resolve missing information, and review the complete summary. The button under the latest summary saves exactly that prepared snapshot. Any edit produces a new revision and invalidates older confirmations. The bot then retrieves the saved Order PDF and sends it only to the configured group. No invoice or customer-email operation is exposed.

The durable write journal prevents duplicate orders on replay. Uncertain saves freeze editing and require reconciliation. PDF delivery uses the existing transport journal: a failed or uncertain document send never recreates the Order; inspect the group before `telegram:recover`. Post-save order edits are currently handled manually in Fatture in Cloud. Existing conversations prepared before this configuration change must be restarted.
