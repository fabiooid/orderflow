# Revoke and rotate OrderFlow tokens

Use this when a Fatture in Cloud API token or a Telegram bot token may be exposed, or when you want to replace tokens on a schedule. Keep new secret values only in local `.env` or your host secret store. Never paste tokens into Telegram, issues, pull requests, chat with an agent, or any public place.

This runbook is operator guidance. It does not invent console click-paths beyond what [CONNECTIONS.md](../CONNECTIONS.md) and the [README Security](../README.md#security) section already describe.

## Before you start

1. Stop the Telegram poller (`Ctrl+C` in the runner terminal). Wait until shutdown finishes.
2. Confirm no second poller is running for the same bot. The local poller lock under `.data/` should prevent a second process; do not delete `.data/` just to clear a lock or an uncertain remote outcome.
3. Prefer keeping `.data/` intact so write journals, delivery state, and conversation storage remain available for recovery. Wipe `.data/` only when you deliberately want a clean local slate **and** you have already reconciled any uncertain Fatture or Telegram outcomes (see [docs/recovery.md](recovery.md) and CONNECTIONS.md recovery sections).

## Fatture in Cloud API token (`FIC_ACCESS_TOKEN`)

### Revoke the exposed token

1. Open your Fatture in Cloud company settings for API / application tokens (the same place you originally created the OrderFlow token; exact menu labels vary by Fatture UI version).
2. Find the OrderFlow token that may be exposed.
3. Revoke or delete that token so it can no longer call the API.

Until you put a replacement into `.env` and restart, OrderFlow cannot reach Fatture. That is expected.

### Create a replacement with the same narrow scope

Create a **new** company API token for OrderFlow. Plan the same scope described in CONNECTIONS.md and the README:

- products: read
- clients: access as needed for matching and optional customer create
- settings / configuration: read as required by `connections:check`
- documents: **order-only** access
- **Do not grant invoice permissions**

OrderFlow's own connector refuses invoice operations, but a scoped token is still required. `npm run connections:check` cannot prove invoice exclusion; confirm that in the Fatture token UI yourself.

### Update the local environment

1. Put the new token only in `.env` as `FIC_ACCESS_TOKEN=...` (or in the host secret store for a deployed runner).
2. Do not commit `.env`.
3. Run:

```sh
npm run connections:check
```

Treat `PASS` as "that read check succeeded", not permission to enable writes. Review every `MANUAL` item, especially invoice exclusion and order-write scope.

4. Restart the poller only when you intend to resume traffic: `npm run telegram:start`.

## Telegram bot token (`TELEGRAM_BOT_TOKEN`)

### Revoke or regenerate

1. Open Telegram and talk to [@BotFather](https://t.me/BotFather).
2. Use BotFather's token revoke / regenerate flow for the OrderFlow bot (for example `/revoke` or the bot settings token controls; follow BotFather's current prompts).
3. As soon as the old token is revoked, any running poller using it will fail authentication. That is the point.

### Update the local environment

1. Put the new token only in `.env` as `TELEGRAM_BOT_TOKEN=...`.
2. If you use webhooks elsewhere, do not point a second integration at the same bot. OrderFlow's local runner uses long polling; CONNECTIONS.md warns not to run two copies for the same bot.
3. Run:

```sh
npm run connections:check
```

4. Restart when ready: `npm run telegram:start`.

If the bot was removed and re-added to the group after privacy-mode changes, re-check `telegram.groupId` with `npm run telegram:discover` as described in CONNECTIONS.md.

## What to do with `.data/`

| Situation | Keep `.data/`? |
| --- | --- |
| Token leak only; no uncertain writes or deliveries | **Keep.** Journals and conversation DBs are still useful. |
| Uncertain Fatture save or Telegram delivery still open | **Keep.** Reconcile with `write:recover` / `telegram:recover` first. Deleting local state does not undo remote writes and can hide evidence. |
| You intentionally want a fresh local deployment and have reconciled remotes | You may remove the relevant `.data/` files for that deployment/mode after a backup. Demo and account modes use separate DBs. |

## After rotation checklist

- [ ] Old Fatture token revoked
- [ ] New Fatture token scoped to catalogue/clients/settings read plus order documents only (no invoices)
- [ ] Old Telegram bot token revoked or regenerated via BotFather
- [ ] New values only in `.env` or host secrets; nothing pasted into chat or git
- [ ] Poller stopped; no second poller
- [ ] `connections:check` re-run; `MANUAL` items reviewed
- [ ] `.data/` kept unless a deliberate clean slate was decided after remote reconciliation
- [ ] `orderSavingEnabled` still false unless Fabio has explicitly approved live saves for this session

## Related

- [CONNECTIONS.md](../CONNECTIONS.md) — setup, scoped tokens, poller, recovery
- [docs/recovery.md](recovery.md) — uncertain Fatture writes
- [README Security](../README.md#security) — private vulnerability reporting; never paste tokens into issues or PRs
- Linear: FAB-34 (this runbook), FAB-24 (`SECURITY.md` backlog; link from there once it exists)
