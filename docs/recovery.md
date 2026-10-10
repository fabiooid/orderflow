# Recovering an uncertain Fatture in Cloud save

A timeout does not tell us whether Fatture in Cloud saved the record. OrderFlow blocks edits and retries until an operator checks. Recovery is a terminal operation, never an agent tool.

Stop the Telegram poller first. These commands use the deployment/group/company in your existing config, acquire the poller lock, and only modify local recovery state. Keep the local databases backed up. `REQUEST_ID` is the request's `orderId` shown in traces, for example `u12345`.

## Inspect

```sh
npm run write:recover -- REQUEST_ID inspect
```

The journal shows the outer operation and any customer/order child writes. `completed` must never be retried; `pending` and `uncertain` need remote inspection. Open Fatture in Cloud and compare the confirmed preview with the remote records. An empty search result alone is not evidence of absence if the service is unavailable or the search is incomplete.

## The record exists

```sh
npm run write:recover -- REQUEST_ID found REMOTE_ID --evidence "Checked record ID and confirmed details in Fatture in Cloud"
```

For customers, the tool reads the customer list and compares all supplied customer fields. For orders, it fetches the specified order and verifies document type, customer/billing identity, date, currency, notes, line products/quantities/prices/discounts/VAT IDs, totals and payment details. A mismatch leaves the request blocked for investigation. It cannot accept an invoice as an order.

Recovery stores the verified result in the journal and returns the request to `ready`. Restart the poller and confirm the existing summary again: the stored result is replayed without creating another record. For an order, its PDF then follows the usual internal-group delivery path.

## A customer exists but the associated order did not finish

If the customer child write is uncertain, reconcile that child first:

```sh
npm run write:recover -- REQUEST_ID client-found CUSTOMER_ID --evidence "Verified this customer matches the confirmed new-customer details"
```

The order remains blocked. If its remote order exists, use `found ORDER_ID`. If you have verified it does not exist, use the next procedure. Completed customer writes are retained and reused.

## Verified absent

```sh
npm run write:recover -- REQUEST_ID retry --verified-absent --evidence "Checked all uncertain operations in FIC; no corresponding record exists"
```

This is an explicit operator assertion, not an automated guarantee. Check **every uncertain child write**, including customer creation. If a child exists, reconcile it first. An incorrect assertion can create a duplicate.

The journal records the assertion and permits one new attempt with the same payload; completed child writes remain completed. Restart and explicitly confirm the existing summary. Recovery itself makes no remote writes. Completed orders cannot be reset through this command.

If the program stopped after journaling success but before updating Telegram state, repeating `found` with the same record is safe. Recovery never changes the confirmed business data.

## PDF delivery

Do not recreate an order because its PDF failed to arrive. Inspect Telegram and use `telegram:recover` for the uncertain message, or `telegram:pdf` to send the existing order PDF deliberately. These are separate from Fatture in Cloud write recovery.
