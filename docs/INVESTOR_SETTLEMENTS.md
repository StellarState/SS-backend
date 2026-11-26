# Investor settlement history (#782)

| Endpoint                                      | Returns                            |
| --------------------------------------------- | ---------------------------------- |
| `GET /api/v1/investors/:wallet/settlements`        | One page of settled investments    |
| `GET /api/v1/investors/:wallet/settlements/export` | Every matching settlement as CSV   |

Both require a bearer token, and `:wallet` must be the caller's own wallet
(otherwise `403 FORBIDDEN`).

## Parameters

| Parameter      | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `from_date`    | Inclusive. `YYYY-MM-DD` starts at 00:00:00Z; or a timestamp with a timezone |
| `to_date`      | Inclusive. `YYYY-MM-DD` covers the whole UTC day; or a timestamp with a timezone |
| `invoice_type` | The invoice's category (e.g. `logistics`), case-insensitive             |
| `limit`        | 1–100, default 20 (JSON only)                                          |
| `cursor`       | `meta.nextCursor` from the previous page (JSON only)                    |

Records are newest first, ordered by `(settled_at, id)`; cursors keep
microseconds, so pages have no gaps or repeats. A wallet with no settlements
gets `data: []`.

## Record

One record per settled investment, computed from what settlement recorded in
the same transaction: the investor's payout (`investor_returns`), their
investment, and the invoice's proceeds, distributed total and rounding
remainder (`settlement_remainders`). All amounts have 4 decimals and use the
same pro-rata floor division as the payout itself.

| Field                | Definition                                                         |
| -------------------- | ------------------------------------------------------------------ |
| `invoice_id`, `invoice_number`, `invoice_type` | The invoice (`invoice_type` is its category, may be null) |
| `settled_at`         | When the settlement was recorded (UTC, milliseconds)               |
| `fractions_held`     | This investment ÷ all settled investments in the invoice, 6 decimals |
| `invested_amount`    | What the investor put in                                           |
| `payout_amount`      | What the investor was paid, net of the platform fee                |
| `fees`               | The investor's pro-rata share of the platform fee: proceeds − distributed − remainder |
| `principal_returned` | `min(payout_amount + fees, invested_amount)`                       |
| `yield_earned`       | `payout_amount + fees − principal_returned` (0 on a loss)          |
| `net_return_usd`     | `payout_amount − invested_amount` (negative on a loss)             |
| `net_return_pct`     | `net_return_usd ÷ invested_amount × 100`, 4 decimals               |
| `fee_data_available` | False for settlements recorded before remainders were stored; their `fees` is 0 |

The rounding remainder is dust kept by the platform, not a fee, so it is not
in `fees`.

## Example

Invoice with 1,000 invested in total, settled for 1,100 with a 2% fee (22),
so 1,078 was distributed. The investor held 250 (25%):

```http
GET /api/v1/investors/GABC…/settlements?from_date=2026-10-01&limit=1
Authorization: Bearer <investor token>
```

```json
{
  "success": true,
  "data": [
    {
      "invoice_id": "0b8e2f41-…",
      "invoice_number": "INV-1042",
      "invoice_type": "logistics",
      "settled_at": "2026-10-05T12:00:00.000Z",
      "fractions_held": "0.250000",
      "invested_amount": "250.0000",
      "payout_amount": "269.5000",
      "principal_returned": "250.0000",
      "yield_earned": "25.0000",
      "fees": "5.5000",
      "fee_data_available": true,
      "net_return_usd": "19.5000",
      "net_return_pct": "7.8000"
    }
  ],
  "meta": { "limit": 1, "hasMore": true, "nextCursor": "eyJ2IjoxLC…" }
}
```

## CSV export

Same filters, same fields, one CRLF-terminated row per settlement, newest
first, with a header row (only the header when nothing matches). Text cells
that a spreadsheet would treat as a formula (`=`, `+`, `-`, `@`) are prefixed
with `'`. An export larger than 10,000 rows is refused with
`422 EXPORT_TOO_LARGE`; narrow the date range.

## Errors

| Status | Code                   | When                                     |
| ------ | ---------------------- | ---------------------------------------- |
| 400    | `INVALID_LIMIT`        | `limit` is not an integer from 1 to 100  |
| 400    | `INVALID_CURSOR`       | Malformed cursor                         |
| 400    | `INVALID_DATE`         | `from_date` / `to_date` not ISO 8601     |
| 400    | `INVALID_DATE_RANGE`   | `from_date` after `to_date`              |
| 400    | `INVALID_INVOICE_TYPE` | Empty or longer than 64 characters       |
| 401    |                        | No or invalid bearer token               |
| 403    | `FORBIDDEN`            | Not the caller's wallet                  |
| 422    | `EXPORT_TOO_LARGE`     | More than 10,000 rows to export          |
