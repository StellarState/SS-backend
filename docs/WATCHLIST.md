# Watchlist

Investors bookmark invoices with `POST /api/v1/watchlist/:invoiceId` and drop
them with `DELETE /api/v1/watchlist/:invoiceId`. Both operations are
idempotent, so clients can retry them freely after timeouts or network errors.

## Identifier normalization

Before any read or write, the service normalizes both halves of the
`(wallet_address, invoice_id)` key:

- **Wallet address**: trimmed and upper-cased. Stellar public keys are
  upper-case base32, so this is lossless.
- **Invoice id**: trimmed and lower-cased, then checked against the UUID
  shape. A malformed id is rejected with `400 INVALID_INVOICE_ID` on both add
  and remove.

As a result, `ABC…` and ` abc… ` refer to the same entry.

## Add (`POST`)

| Situation                      | Status | Body                                            |
| ------------------------------ | ------ | ----------------------------------------------- |
| Entry created by this request  | `201`  | `{ success, data: entry, meta: { created: true } }`  |
| Entry already existed          | `200`  | `{ success, data: entry, meta: { created: false } }` |
| Invoice does not exist         | `404`  | `INVOICE_NOT_FOUND`                             |
| Malformed invoice id           | `400`  | `INVALID_INVOICE_ID`                            |

A repeated add never creates a duplicate row and never returns a uniqueness
error. If the entry already exists, its `notes` are left as they were: the
first write wins, so a delayed retry cannot overwrite newer state.

## Remove (`DELETE`)

Remove always returns `204` for a well-formed id, whether or not the entry
existed. Either way the entry ends up absent. The remove is a single
conditional `DELETE`, so there is no gap between a read and a write for
another request to slip into.

## Concurrency

The unique index `uq_watchlist_wallet_invoice` on
`(wallet_address, invoice_id)` is what settles races. The service does not
check for an existing row and then insert. It inserts with
`ON CONFLICT DO NOTHING` (Postgres) or `INSERT OR IGNORE` (SQLite) and then
reads the row back.

- **Concurrent adds**: exactly one insert wins and gets `201`. The others are
  ignored by the database and get `200` with the winner's row. No request
  fails.
- **Concurrent removes**: every request gets `204`. Only one of them actually
  deletes the row.
- **Concurrent add and remove**: the final state depends on which request the
  database applies last. Both outcomes are valid:
  - Add commits, then remove runs: the entry is absent.
  - Remove runs, then add commits: the entry is present.
  - Remove deletes the row between the add's ignored insert and its read-back:
    the add returns `409 WATCHLIST_CONCURRENT_MODIFICATION` instead of
    reporting a state that no longer exists. Retrying the add is safe.

  Clients that send add and remove at the same time for the same invoice
  should treat the last response they *received* as advisory and re-fetch
  `GET /api/v1/watchlist` if they need the authoritative state.

## Soft-deleted rows

The table has a `deleted_at` column, and the unique index also covers rows
where it is set. If an add finds a soft-deleted row for the same key, it
restores that row and returns `201` instead of failing.
