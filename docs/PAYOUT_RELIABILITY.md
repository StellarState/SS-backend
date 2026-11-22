# Dividend claims and royalty statements

The backend reserves claims and indexes confirmed contract payouts. Claim reservation
and transaction binding do not send funds. The caller signs and submits through its
existing contract integration only after binding the prepared transaction hash.
The backend never resends a payout from a reconciliation job.

## Dividend snapshots

Each `DividendDistributed` event identifies `distribution_id` (or `cycle_id`),
`revision` (positive integer, default 1), and the emitting contract. The complete
recipient allocation list becomes an immutable snapshot. `total_amount` is the
independently reported contract total; `claimed_total` is the independently reported
cumulative claimed amount. If no claim total is available, reconciliation reports
that gap instead of treating it as zero. When no cycle ID is supplied, the stable
event ID identifies the cycle. All monetary amounts use decimal strings at four
places, matching the existing database schema.

Distribution and allocation rows commit together. Each confirmed distribution projection belongs to
exactly one snapshot. Replaying a snapshot repairs missing projection rows without
changing snapshot values. A different allocation requires a higher revision; prior
revisions are locked and cease contributing to current entitlements. Recalculation
is rejected when any prior payout is pending or successful. A failed reservation
can be corrected through a new revision.

`GET /api/v1/dividends/claimable` includes `snapshotId`, `revision`, and `locked`
for each cycle. Its cache can be up to 30 seconds old; claim requests always read
the locked database snapshot and recompute entitlement without consulting the cache.

Authenticated holder requests:

```http
POST /api/v1/dividends/claims
Content-Type: application/json

{"snapshotId":"<snapshot UUID>","revision":1}
```

The backend locks the snapshot row and reserves the exact remaining allocation.
Locked or recalculated cycles and absent entitlements return 409. Concurrent
requests for the same holder, snapshot and revision return the same durable
reservation. Existing reservations remain retrievable after a lock.

The authenticated issuer can lock a cycle with
`POST /api/v1/dividends/cycles/{snapshotId}/lock` (204) or inspect reconciliation with
`POST /api/v1/dividends/cycles/{snapshotId}/reconcile` (200).

## Royalty claim reservations

`RoyaltyPaid` events may carry `cycle_id`, `cycle_at` (UTC timestamp), `revision`,
`gross`, `platform_fee`, and `amount` (net). Gross minus platform fee must equal
net. Defaults preserve legacy events: gross equals amount, platform fee is zero,
and cycle date is the payment date. The emitting contract and stable event ID
identify a transfer, including multiple transfers in one transaction. Legacy
rows remain readable; cycle claims require an explicit cycle ID.

Creators (seller or both accounts) request:

```http
POST /api/v1/royalties/claims
Content-Type: application/json

{"cycleId":"2026-03","revision":1}
```

The idempotency key hashes the payout kind, authenticated wallet, cycle, and
revision. The reserved gross, fee and net are immutable. Pending reservations
return 202; retries after confirmed completion or failure return 200 with the
original outcome. Late accrual events cannot alter a reserved revision. A newer
revision is required after a confirmed terminal failure, and pending earlier
revisions block a new reservation. Confirmed payments from earlier revisions are
subtracted so recalculation cannot pay the same entitlement twice.

## Transaction binding and callbacks

For either payout kind, bind the prepared hash before submission:

```http
POST /api/v1/royalties/claims/{key}/transaction
Content-Type: application/json

{"txHash":"<64 hexadecimal characters>"}
```

The dividend equivalent is `/api/v1/dividends/claims/{key}/transaction`. Only the
reservation owner can bind it. Every retry uses the same hash. Changing the hash
returns 409. Contract integrations must include the reservation `key` as
`claim_id` in the confirmed `RoyaltyClaimed` or `DividendClaimed` event, along with
its cycle and revision. Callbacks atomically finalize the outcome and claim
projection; they validate wallet, amount, and any bound transaction. Replaying
concurrent callbacks does not create another claim.

The worker polls bound pending transaction hashes using Soroban RPC. Only a
ledger-confirmed `FAILED` transaction marks a reservation failed. Timeouts,
`NOT_FOUND`, and pending transactions remain pending, avoiding a second payout
while confirmation is ambiguous. A successful transaction remains pending until
its claim event has been indexed. Existing events without revision metadata remain
visible as legacy claims and are deduplicated on their original claim identifier.

## Reconciliation

Every 30 seconds, the worker processes at most 25 due snapshots. It repairs missing
allocation projections from immutable values and compares database distributions,
allocations, claims and completed reservations with independently reported contract
totals. Reports include decimal totals, snapshot identity, pending amounts, and
specific discrepancy codes. Reports contain no raw event payloads, envelopes,
credentials or exception text.

A discrepancy is retried at most three times with persisted exponential backoff,
then quarantined. Restarting the worker resumes due rows; it never sends payouts.
Replayed events do not reset retry budgets. Fresh independent `claimed_total`
evidence can reopen reconciliation after an operator or contract update.

## Royalty statements

`GET /api/v1/royalties/statements` returns `data`, page `totals` (gross, platformFee,
net), and `meta` (`hasMore`, `nextCursor`). Filters compose:

| Query | Meaning |
| --- | --- |
| `limit` | 1–100, default 50 |
| `cursor` | Opaque next cursor; reuse with the same filters |
| `cycle_from`, `cycle_to` | Inclusive UTC cycle date range |
| `key_address` | Exact creator key |
| `revision` | Exact positive revision |

Rows sort by immutable ingestion sequence, with a watermark in the cursor. Updating
payment dates or inserting later events cannot duplicate rows or shift an existing
row between pages. Cursors are bound to the wallet and normalized filters; invalid
or mismatched cursors return 400.

`GET /api/v1/royalties/statements/export?format=json` returns all filtered rows and
totals. `format=csv` returns a CSV attachment with totals in `X-Statement-Gross`,
`X-Statement-Platform-Fee`, and `X-Statement-Net`. Exports use one database snapshot
and the same filters as listing; CSV quotes fields and escapes spreadsheet formulas.
Exports accept at most 10,000 rows and return 413 beyond that limit; narrow the cycle
range or use paginated statements. Exports do not accept a cursor. Existing earnings
and claim-history endpoints remain available.

## Verification

Run `npm run ci` with Node 22 and an isolated PostgreSQL `DATABASE_URL`. The payout
integration suite creates and drops its own schema. It exercises real concurrent
transactions, rollback, callback replay, terminal failure recovery, report resume,
statement pagination during updates, composed filters, and authenticated APIs.
