# Secondary market revisions and depth

## Revision preconditions (#838)

Listing responses include the existing integer `version`. Both
`DELETE /api/v1/secondary/listings/{id}` and
`POST /api/v1/secondary/listings/{id}/cancel` require JSON
`{ "expected_version": 1, "reason": "optional explanation" }`. The same routes
are available under `/api/v1/secondary-market`. Missing versions return 428
`LISTING_PRECONDITION_REQUIRED`; malformed versions return 400.

`PATCH /api/v1/secondary/listings/{id}` relists an active ask with JSON
`{ "expected_version": 1, "quantity": "30", "price_per_fraction": "1.5" }`.
It checks ownership, live holdings, invoice tradability and settlement state.
Cancelled, sold, expired, or purchased listings cannot be relisted.

Cancellation and relisting serialize on the listing row. A stale request gets
409 `LISTING_CONFLICT` with `listing_id`, `expected_version`, `current_version`,
`status` and `quantity`. Fetch the current listing and decide whether to submit
a new request. Cancellation also rejects any linked purchase, including a
partial purchase with an active remaining quantity. Repeating a successful
cancellation with its original version and reason returns the stored cancelled
listing; repeating an identical relist with its original version returns the
updated listing. Neither retry advances the revision again.

## Depth snapshots (#839)

`GET /api/v1/secondary/invoices/{invoiceId}/depth` returns the latest committed
ask depth, grouped by numeric price in ascending order. Quantities and prices
are decimal strings; each level includes `listing_count`. The snapshot has a
monotonic string `id`, `invoiceId`, `capturedAt` and nullable `validUntil`.
The endpoint is also mounted under `/api/v1/secondary-market`.

Cadence is event driven: PostgreSQL triggers append snapshots in the same
transaction as every listing insert, update or deletion and every invoice
status, deletion or maturity-date change. Rollbacks remove the corresponding
snapshots. Per-invoice advisory transaction locks serialize aggregation across
instances. A terminal invoice or sold, cancelled, deleted or expired listing
is excluded immediately. Only active asks on live funded invoices contribute;
there is no secondary bid book in this API.

A 30-second worker sweep refreshes books whose next listing expiry or invoice
maturity has passed. Reads check `validUntil` and refresh expired books before
returning them, so the worker's 30-second bound does not permit an expired book
to be served. Normal reads retrieve stored snapshots without re-aggregating
listings. `stellarsettle_secondary_depth_snapshot_lag_seconds` reports observed
expiry refresh lag without invoice labels. It is exported through `/metrics`.

`GET /api/v1/secondary/invoices/{invoiceId}/depth/history?limit=20&cursor=...`
returns immutable newest-first snapshots with `meta.next_cursor` and
`meta.has_more`. The limit is 1 through 100. Cursors bind the invoice, last
snapshot and first-page high-water mark, preventing newly appended snapshots
from changing subsequent pages. Cursors cannot be reused for another invoice.
History is retained for 90 days. Old history is pruned on updates and by the
worker; the latest snapshot of a dormant book is kept for current reads.

The PostgreSQL integration tests exercise a burst of 40 concurrent listing
creations followed by 40 cancellations and compare exact quantities and counts
with the final book, alongside rollback, expiry and cursor tests.

## Purchase integrity (#747–#750)

### Trading cutoff (#747)

Secondary trading in an invoice stops when its maturity day begins:
00:00:00Z on `due_date` (`secondaryTradingCutoff` in `src/utils/date.utils.ts`).
Trading is allowed while `now < cutoff`; at the cutoff itself it is not. The
same rule applies to listing creation, purchase, relisting, the listing browse
endpoint and the depth book (`due_date > today`). It is earlier than primary
investment eligibility, which runs to the end of the due day, because a trade
must complete before the invoice settles.

- A purchase checks the cutoff after locking the invoice, so an invoice that
  stays `funded` past maturity while it awaits settlement cannot be traded,
  whatever the listing's own expiry. The purchase fails with
  `422 INVOICE_MATURED` (`details.trading_cutoff`) and writes nothing.
- A custom `expiresAt` later than the cutoff is rejected with
  `400 INVALID_EXPIRY`; without one, a listing expires at the cutoff.
- The settlement-in-progress check (`409 SETTLEMENT_IN_PROGRESS`) is unchanged.

### Cancellation against purchase (#748)

Purchase, cancellation and relisting all lock the listing row first
(`SELECT … FOR UPDATE`), and purchase and relisting then lock the invoice,
then holdings. The order is always listing → invoice → holdings, so the
operations serialize without deadlocking. Owner, status and version are
checked after the lock. Whichever operation locks the listing first wins:

- a purchase that wins leaves the listing `sold` (or reduced), and the waiting
  cancellation gets `409 LISTING_CONFLICT`;
- a cancellation that wins leaves it `cancelled`, and the waiting purchase gets
  `LISTING_NOT_ACTIVE` with no trade, payment or holding change.

A stale cancellation after a partial fill also gets `409 LISTING_CONFLICT`, so
it can never restore the old quantity or total price.

### Entitlement transfer (#749)

A purchase moves both the principal (`investment_amount`) and the matching
share of the projected settlement entitlement (`expected_return`) from the
seller's holdings to the buyer's. Taking `q` of a holding with principal `A`
and expected return `R` moves `R × q / A`, rounded down to 4 decimals; the
seller keeps the rounding dust until a later fill empties the holding, which
moves everything left. So:

- a fully exited seller keeps no principal and no projected payout;
- partial owners keep returns proportional to their principal;
- an existing buyer position gains both principal and expected return; a new
  one starts with the transferred values, not principal alone;
- the total entitlement of all owners never changes.

The price the buyer paid is not part of the settlement claim. It is recorded
on the trade (`secondary_trades.gross_amount`) and in the payment
transactions. Portfolio values, which use `expected_return` for open positions,
follow the new ownership.

For example, a seller holding 1,000 principal with 1,050 expected sells 250:
the seller is left with 750 / 787.5 and the buyer has 250 / 262.5, whether the
buyer paid 0.9 or 1.2 per fraction.

### Conservation (#750)

Only positive principal can back a fill. If the seller's locked holdings
cannot cover the requested quantity, the purchase fails before anything is
written, with `409 SELLER_HOLDINGS_INSUFFICIENT`. The transfer itself also
refuses to finish unless it deducted exactly the quantity it credits
(`409 UNBACKED_FILL`). Every write — listing quantity and status, seller and
buyer holdings, trade and payment records — happens in one transaction, so any
failure rolls all of them back. A successful trade leaves the total confirmed
principal of the invoice unchanged.

### Tests

`tests/integration/secondary-market-purchase-integrity.integration.test.ts`
runs against PostgreSQL. It covers:

- moving the clock across maturity while the invoice stays `funded` and the
  listing stays unexpired;
- the exact cutoff, for both creation and purchase;
- pausing a purchase or a cancellation while it holds the listing lock, so the
  other operation reaches the listing read and waits;
- repeated partial fills on a discounted invoice, at prices above and below
  principal;
- an unbacked seeded listing, and an injected failure after every holding
  write, both checked for complete rollback.
