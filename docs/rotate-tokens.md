# Revoke and rotate Fatture in Cloud and Telegram tokens

Use this runbook when a Fatture in Cloud API token or a Telegram bot token may be exposed, or when you are replacing those tokens on purpose. The values live in the local `.env` file and in any host secret store you already use. They are not stored in `.data/`.

Never paste the old or new tokens into Telegram, chat, issues, pull requests, or the public repository. Type replacements only into the local `.env` file, or into the host secret store your operator already uses. This page does not set up hosting secrets. First-time token setup is in [CONNECTIONS.md](../CONNECTIONS.md).

This runbook covers `FIC_ACCESS_TOKEN` and `TELEGRAM_BOT_TOKEN` only. Do not enable order saving as part of this procedure. Leave `orderSavingEnabled` as it already is.

## 1. Stop the poller

Stop the Telegram runner first so the old tokens are not used while you replace them. If Mastra Studio is open against this same `.env`, stop that too.

If the runner is in the foreground, press Ctrl+C. Shutdown waits for the current poll or operation to finish. [CONNECTIONS.md](../CONNECTIONS.md) describes this stop.

Do not start another copy for the same bot. Telegram allows only one long-polling client per bot token.

Confirm no second poller is running:

1. Check the terminal that usually runs `npm run telegram:start`. It should have exited.
2. Do not start a replacement runner until the new tokens are in `.env`.
3. The lock file is `.data/telegram-<deploymentId>.lock`, where `deploymentId` comes from your business config. A lock from an already exited process is reclaimed on the next start. Do not delete `.data/` to clear a lock, and do not delete `.data/` to fix an uncertain remote save or delivery. Use [docs/recovery.md](recovery.md) and `telegram:recover` for those.

When you start the runner later in this runbook, a second process fails with `A Telegram poller is already running for this deployment`. Stop that other process. Do not run two copies for the same bot.

`npm run telegram:discover` also needs other pollers stopped.

## 2. Revoke the Fatture in Cloud token and create a replacement

The env name is `FIC_ACCESS_TOKEN`. The token must belong to the company in your business config.

Open Fatture in Cloud API token settings for that company. Use Fatture's current token or connected-applications settings. Do not follow a guessed click path if the screens have changed.

If the token may already be exposed, revoke it first so the leaked value stops working, even if that means a short outage. Then create the replacement. If you are rotating on a schedule and the current token is not exposed, create the replacement first, switch `.env`, confirm access, then revoke the old token.

Create the replacement with the same orders-only scope that [README.md](../README.md) Token permissions and [CONNECTIONS.md](../CONNECTIONS.md) already describe:

- read access to products
- client access
- order-only document access
- read access to settings and configuration as required
- **Do not grant invoice permissions.**

Put the new value only in local `.env` as `FIC_ACCESS_TOKEN`.

`npm run connections:check` can confirm company, catalogue, and client reads. It does not prove that invoice rights are absent, and it never attempts an invoice request. Check the new token's permissions in Fatture yourself.

If order saving was already enabled, the replacement still needs order document access that can write orders. Do not turn saving on in config during rotation.

## 3. Revoke and regenerate the Telegram bot token

The env name is `TELEGRAM_BOT_TOKEN`. Use Telegram BotFather for the same bot this deployment already uses.

Open BotFather and revoke or regenerate that bot's token. Telegram then invalidates the previous token and issues a new one for the same bot. Put the new value only in local `.env` as `TELEGRAM_BOT_TOKEN`.

Keep the same internal group. You do not need a new group or a new bot for a token rotation.

If this bot had a webhook from an earlier integration, `connections:check` reports whether polling is clear. Do not replace a webhook automatically. [CONNECTIONS.md](../CONNECTIONS.md) says to use a dedicated bot or remove the previous integration yourself.

Regenerating the token does not change BotFather privacy settings. Leave privacy as it already is unless you are also changing who the bot can hear.

## 4. Decide whether to keep or wipe `.data/`

`.data/` holds local poller state, not the tokens:

- `telegram.db` holds the poll offset, message links, and delivery state.
- `telegram-<deploymentId>-<mode>.db` holds conversation memory and traces.
- `customer-writes.db` is the durable write journal for customer and order saves.
- `telegram-<deploymentId>.lock` is the single-poller lock.

**Keep `.data/`** in the usual rotation. New tokens work with the existing local state. Keep it when:

- A Fatture in Cloud save is uncertain. Follow [docs/recovery.md](recovery.md) first. Wiping the journal can lose the evidence you need and can lead to a duplicate save.
- A Telegram delivery is uncertain. Reconcile with `telegram:recover` as [CONNECTIONS.md](../CONNECTIONS.md) describes. Do not delete `.data/` to fix that.
- You want operators to continue the open request instead of starting over.

**Wipe `.data/`** only when you want a blank local start **and** you have already checked that there is no uncertain remote save and no uncertain Telegram delivery. Wiping does not revoke leaked tokens. It also drops traces, aliases stored in Mastra memory for this deployment, open drafts, and poll offsets. Demo and account conversations are stored separately by mode. Wiping the folder removes both.

Copy `.data/` somewhere private first if you might need the write journal later. Those files can contain conversation and customer data. Keep the copy out of git.

## 5. Confirm the new tokens, then start one poller

```sh
npm run connections:check
```

A zero exit code means the automated reads succeeded. It is not permission to enable writes, and it does not prove that invoice rights are absent.

Then start exactly one runner:

```sh
npm run telegram:start
```

If startup reports that a poller is already running, stop the other process. Do not run two copies for the same bot.

## Related

- [CONNECTIONS.md](../CONNECTIONS.md): first-time tokens, group discovery, poller lock, and delivery recovery
- [README.md](../README.md): Security and Token permissions
- [docs/recovery.md](recovery.md): uncertain Fatture in Cloud saves
