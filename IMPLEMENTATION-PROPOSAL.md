> Updated implementation decision (1 October 2026): Telegram uses one shared Mastra conversation per group and one active request. Natural messages start/edit orders and customers; slash commands are optional. The latest summary must be explicitly confirmed before saving, using its inline button or confirmation command. PDFs return only to the group. Earlier proposed automatic saving and parallel order routing below are superseded.

# OrderFlow — V1 implementation proposal

Status: foundation implemented on 25 September 2026 after user authorization. See README.md for implemented capabilities, verification commands, and remaining milestones. Dependencies installed; no credentials accessed or live business API writes performed. Account-specific behavior remains to be tested. The sections below describe the full target V1, not a claim that every capability is already implemented.

## Open-source structure and boundaries

Build an unofficial integration on the official Fatture in Cloud SDK, with one repository and three independently testable modules:

- **Connector:** typed catalogue, client, order, totals, and PDF operations. Accept explicit validated inputs and an injected authenticated client. No Telegram, LLM, memory, branding, or business tax decisions. Never expose the entire underlying SDK as an agent tool.
- **Mastra assistant:** configured business policies, matching, clarification, workflow execution, memory, and evaluations. Consume the connector through narrow tools and reuse Mastra capabilities before introducing custom alternatives.
- **Telegram adapter:** translate messages, recordings, images, replies, and buttons to assistant events; deliver replies and PDFs. Keep Telegram identifiers out of connector contracts.

Start with one configured company per deployment. Multi-company SaaS, a plugin marketplace, and additional messaging adapters are future scope. Module boundaries do not require publishing three npm packages for V1.

Orders-only and no customer sending are enforced V1 capability limits across the public connector and assistant, not configuration switches. Deployment policies may narrow these capabilities but cannot enable invoices, proformas, or sending.

Public deliverables: setup documentation, configuration reference, fictional example configuration, synthetic fixtures, contribution guidance, and an explicitly selected open-source license. License choice and dependency-license review remain release prerequisites; no license has been chosen or publication authorized. Describe the project as unofficial without implying endorsement.

Exclude deployment configuration, secrets, real customer data, PDFs, recordings, screenshots, database files, traces, and learned memory from the public repository. Logs and fixtures must not copy real sample documents. Public prompts and examples use neutral terminology and no business branding.

## Configuration contract

All business choices belong in a versioned, validated configuration schema with documented defaults:

- Company reference, selling/shipping origin, currency, supported language, and catalogue price basis. V1 supports net B2B catalogue pricing only; unsupported gross/retail modes must fail validation rather than silently behave as net.
- Allowed Telegram group, localized commands, operator access policy, and review/reopen behavior. The initial deployment allows all human members of its configured group to act on any order.
- Product attributes and confirmed alias rules. Variants are catalogue entries; no fixed tester suffix or product-code convention in matching logic.
- Shipping product reference, proposed charge source, discount eligibility, and whether delivery is excluded by default.
- Required client fields conditional on country and business type, billing/delivery defaults, and notes storage policy.
- VAT conditions, configured treatment references, rule priority, validation policy, and exception handling. Rates and nature codes are deployment rules, not universal library defaults.
- Payment method/due-date resolution policy, pre-save review policy, and shared-memory retention/update policy.
- Model/transcription selection, usage bounds, storage, and logging/retention settings.

Keep secrets in environment variables or a secret store referenced by configuration. Validate structure at startup and resolve company-specific product/VAT/payment references during an authenticated readiness check. Reject unsupported options, contradictory or overlapping rules without explicit precedence, and missing required mappings. An unmatched runtime case asks for review instead of falling through to a guessed treatment. The LLM cannot edit configuration or override capability restrictions through memory.

Snapshot the effective policy version on each order so later configuration changes cannot silently reinterpret an in-progress order. Keep initial deployment choices in private configuration; ship only fictional examples publicly.

## Initial deployment profile

An internal Telegram group for operators, processing roughly 1–5 B2B orders daily, mainly in Italian and occasionally English. These are initial deployment settings, not restrictions on all users of the connector. Anyone in the configured group may create, edit, and review any order under this profile.

Inputs: text, recorded voice notes, screenshots. Match products by name, configured attributes such as size, and variant; codes are internal identifiers, not required user input. Fatture in Cloud is authoritative for catalogue entries and wholesale prices excluding VAT. Variants must have distinguishable catalogue entries and prices; catalogue readiness has not yet been checked. No particular code format is required.

Collect existing or new client details alongside the order: business name, billing address, email, phone, VAT/tax identification as applicable, and Italian SDI code. Default delivery destination to billing address. Store a differing shipping address in client notes without replacing unrelated notes, and snapshot the destination on the order. Delivery instructions belong to the order notes.

Delivery is the existing shipping product; propose its default price and let the operator set the amount during preparation. Percentage discounts exclude shipping unless explicitly included. Keep payment method and due date at configured defaults, resolving those defaults through API data rather than assuming omission reproduces the UI.

Resolve missing and ambiguous details, then save an Order and post its PDF internally. A separate pre-save approval is not mandatory. Corrections modify that same order and produce a new PDF revision. Review is an application status, not an invoice or sending action.

Hard exclusions: invoice creation, proformas in V1, automatic customer sending, retail/OSS, separate price lists, live phone calls, generated speech, and autonomous catalogue edits.

## Recommended technical design

Use TypeScript and Node.js with Mastra as the backend framework, one conversational agent, and explicit workflows for order preparation and persistence. Use Mastra tools, structured schemas, suspend/resume, storage, memory, tracing, and evals. Avoid additional orchestration frameworks.

Run one application instance for the pilot, with persistent storage and backups. Mastra's libSQL adapter is a reasonable starting choice for messages, memory, and workflow state. Small application-owned records will track Telegram routing, order revisions, and external-write recovery; these are business records rather than a replacement for Mastra persistence. Hosting provider and current cost remain unselected; durable disk and an HTTPS endpoint are the requirements if using webhooks.

Mastra supports custom API routes, so a separate web framework is not required solely to receive Telegram updates. Use the official Fatture in Cloud TypeScript SDK behind narrow tools. Pin dependency versions when implementation begins.

Sources: [Mastra custom routes](https://mastra.ai/docs/server/custom-api-routes), [libSQL integration](https://mastra.ai/integrations/databases/libsql), [Fatture in Cloud TypeScript SDK](https://github.com/fattureincloud/fattureincloud-ts-sdk).

## Conversation and workflow design

Proposed interaction default: start with a configured command (for example `/order` or an Italian alias) and reply to the bot's prompt with text, audio, or a screenshot. Continue through replies and order-specific buttons. This works with Telegram group privacy mode; ordinary unaddressed group messages are not guaranteed to reach the bot. If friction proves excessive, deliberately change the dedicated group's privacy configuration rather than assuming all messages arrive.

Allow only the configured internal group. Use sender identity for attribution, not as the owner of the order. Link Telegram reply/message identifiers to an order and its Mastra thread. If a follow-up cannot be assigned unambiguously, ask which order it concerns.

Flow:

1. Record and deduplicate the incoming update before acknowledging receipt.
2. Route to a new or existing order; normalize audio/image input.
3. Extract proposed client, lines, destination, delivery, discount, and notes into a validated schema.
4. Search catalogue/client candidates and ask targeted questions for unresolved matches. Never invent product IDs or prices.
5. Suspend while waiting for answers; resume the persisted Mastra workflow when the reply arrives.
6. Resolve configured prices, VAT IDs, payment defaults, and totals.
7. Save the client if necessary, then the order, tracking each external result separately.
8. Retrieve the saved document and PDF; post the PDF with order reference and revision.
9. Apply requested changes through the update workflow; mark older PDFs superseded. Reviewing an old revision must not mark the current revision reviewed.

Proposed review behavior: any member may mark the latest revision reviewed; subsequent changes explicitly reopen it. This is a proposed default, not a separately confirmed requirement.

Sources: [Telegram group privacy](https://core.telegram.org/bots/features#privacy-mode), [Mastra suspend/resume](https://mastra.ai/docs/workflows/suspend-and-resume).

## Fatture in Cloud integration findings

Documented capabilities include listing products and clients, creating/updating clients, creating/updating issued documents, calculating totals, and retrieving document download URLs. Orders are a supported document type. Existing clients can be filtered by VAT number.

Use only product read access, client write access, order write access, and any demonstrated read-only configuration permissions. Crucially, the API offers a dedicated `issued_documents.orders` scope: withhold invoice and other document-type scopes. Manual authentication is documented and fits a single-company pilot; OAuth can be considered if this later becomes a multi-company product.

The application must additionally restrict the document type to `order` and expose no email, invoice, transformation, or deletion tool. Order write permission alone should not be assumed to prohibit emailing an order; enforce the no-send rule through an allowlisted integration interface. No generic authenticated HTTP tool is available to the model.

The API does not automatically copy every client field into a document merely because its client ID is supplied. Fetch and populate the required fields explicitly. Verify how catalogue fields and configured payment defaults need to be transferred during the account integration test.

Document URLs expire after seven days. Retrieve a fresh URL when necessary and upload the PDF to Telegram as a document attachment. A failure to fetch or post the PDF must retry that step, not create another order.

The Italian new-company lookup by VAT number has not been found in the reviewed public API documentation. Searching existing clients is verified; fetching a new company's registry details is a separate unresolved capability. Collect details in chat as the fallback.

Sources: [Permissions](https://developers.fattureincloud.it/docs/basics/scopes/), [manual authentication](https://developers.fattureincloud.it/docs/authentication/manual-authentication/), [document creation and client population](https://developers.fattureincloud.it/docs/guides/invoice-creation/), [client filtering](https://developers.fattureincloud.it/docs/basics/filter-results/queries/), [PDF URL expiry](https://developers.fattureincloud.it/blog/url-expiration/), [Telegram PDF delivery](https://core.telegram.org/bots/api#senddocument).

## Context and memory

Use one Mastra thread per order and a business/group resource for shared knowledge. Order state is structured application/workflow data; conversation memory is context, not the sole record of what should be saved.

Start with bounded message history and structured working memory. Mastra supports thread- and resource-level memory; no custom memory engine is needed. Begin without vector search or observational compression, adding either only when evals demonstrate a need.

Proposed shared memory policy: store explicitly confirmed aliases and corrections with catalogue/client references and source-message attribution. Keep customer-specific facts scoped to that customer. Do not promote one-time discounts, addresses, or delivery instructions into general defaults. Prices, VAT configuration, permissions, and order status stay authoritative outside model-editable memory. Serialize shared-memory updates to avoid losing simultaneous corrections. Provide a way to inspect and correct learned mappings.

Source: [Mastra working memory](https://mastra.ai/docs/memory/working-memory).

## VAT configuration and exceptions

The reusable engine evaluates explicit deployment rules for billing country, delivery destination, customer status, and validation outcome. The initially discussed Italian B2B treatments belong in private deployment configuration; they are not independently validated tax rules or universal defaults for installations. A public fictional configuration must clearly label its illustrative rules and require operators to supply their own approved mappings.

Read actual VAT types from the company and map these treatments to the correct IDs. Capture both billing country and actual delivery destination. Do not infer all international cases solely from a country name: unusual territories, mismatched billing/delivery countries, missing identifiers, and other unconfigured cases require review. Do not assume every non-EU business has an EU-style VAT identifier.

VIES is a desirable low-complexity addition, not a blocker to initial text-flow development. Verify the current service contract during integration. Represent valid, invalid, and unavailable results separately; a service outage is not an invalid VAT number. Store the check outcome and date. Proposed behavior for unresolved validation: pause tax-dependent saving for operator review rather than automatically substituting a different tax treatment.

Source: [European Commission VIES](https://ec.europa.eu/taxation_customs/vies/?locale=eng).

## Reliability that remains custom work

Mastra workflow persistence does not make external API writes exactly-once. No remote idempotency guarantee has been established in this discovery.

- Deduplicate Telegram delivery retries by update identity. Treat a separately forwarded identical order as a possible duplicate to ask about, since it could be legitimate.
- Serialize changes to each order and maintain revision numbers; reject stale review actions.
- Store pending/completed client and order writes separately. After a timeout with an unknown result, reconcile with Fatture in Cloud before retrying creation. If a unique match cannot be established, ask for reconciliation instead of blindly recreating.
- Reuse a successfully created client if order creation fails.
- Fetch the current external order before changes; detect manual changes in Fatture in Cloud rather than overwriting them silently.
- Keep external writes in dedicated steps, separate from steps that suspend for questions.
- Use deterministic calculation/validation and Fatture in Cloud's totals API to check rounding. Express a whole-order percentage as discounts on eligible lines; exclude the shipping line by default.

## Models, transcription, and evaluations

Choose a low-cost tool-capable model by benchmarking actual order conversations against a stronger reference model. No particular model or price has yet been selected or measured. Use inexpensive file transcription and text responses; avoid a live voice platform. Evaluate an audio-capable model as an alternative if its total cost and accuracy are better. Use a vision-capable model for screenshots while keeping the downstream workflow unchanged.

Use Mastra datasets/experiments and scorers. Exact fields, tool arguments, amounts, and forbidden actions get deterministic checks; conversational quality can use model-based scoring. Measure cost per completed order, retries, clarification count, and critical errors rather than token price alone.

Initial public cases: wholly synthetic orders with known net, VAT, and gross totals, distinct variants sharing a base name, missing sizes, Italian spoken corrections, English order, shipping-price override, discounts with/without shipping, new client, ambiguous client, foreign customer with Italian delivery, invalid/unavailable VAT validation, interleaved orders, duplicate updates, stale review button, API timeout after save, PDF failure, and attempts to create invoices or contact customers. Keep the supplied real sample outside the public repository; construct synthetic fixtures independently. Add configuration tests for a second fictional business with different product names, shipping code, VAT mapping, language, and discount policy to detect hardcoded assumptions.

Source: [Mastra evaluation guidance](https://mastra.ai/articles/ai-agent-evaluation).

## Implementation sequence and evidence required

1. Foundation: establish the three module contracts and validated configuration schema, then pin current Mastra/SDK versions; configure storage, schemas, narrow tools, tracing, and mocked integrations. Prove prohibited actions are unavailable and restart recovery works.
2. Text workflow: catalogue matching, clarification, new clients, VAT mapping, shipping, discounts, shared-group routing. Prove correct structured orders from reference conversations.
3. Account integration: verify plan/API availability, minimum scopes, distinct variant entries, defaults, order updates, totals, PDFs, and timeout reconciliation using controlled test orders once implementation is authorized.
4. Media and memory: add recordings, screenshots, confirmed mappings, and correction handling. Run the same order assertions for all input types.
5. Pilot: initial operators use the group; inspect PDFs and traces, measure costs, and convert observed failures into regression cases.

Readiness inputs: Telegram bot token and allowed group ID, Fatture in Cloud company/token and suitable API plan, one model-provider credential, unambiguous catalogue variant entries, and a few representative recordings/screenshots. Configure credentials securely during implementation, not in this document or group chat.

Unresolved decisions are bounded: open-source license before release, hosting provider, model/transcriber selected by tests, exact account defaults and VAT IDs, group trigger preference, shared-memory update policy, and exceptions policy. Proposed defaults above allow implementation planning without pretending these have all been explicitly approved.
