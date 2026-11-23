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
