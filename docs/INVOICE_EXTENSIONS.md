# Funding deadline extensions

A seller can ask to move an invoice's funding deadline later; an admin
approves or rejects the request.

| Endpoint                                                          | Who    |
| ----------------------------------------------------------------- | ------ |
| `POST /api/v1/invoices/:id/extension-request`                     | Seller |
| `POST /api/v1/admin/invoices/:invoiceId/extensions/:requestId/review` | Admin  |

```http
POST /api/v1/invoices/6f1c9a52-…/extension-request
Content-Type: application/json

{ "proposedDeadline": "2026-12-15T17:00:00-05:00", "reason": "Buyer needs more time" }
```

```http
POST /api/v1/admin/invoices/6f1c9a52-…/extensions/0d4f3c2a-…/review
Content-Type: application/json

{ "decision": "approve", "reviewNote": "OK" }
```

## Deadline rules (#733)

`proposedDeadline` is an ISO 8601 timestamp, compared as an instant (so
`2026-12-09T22:00:00-03:00` is `2026-12-10T01:00:00Z`). A bare date such as
`2026-12-15` means the end of that day in UTC, `2026-12-15T23:59:59.999Z`,
the same convention as invoice maturity.

A proposal must be:

1. **In the future.**
2. **Strictly later than the current funding deadline.** A proposal equal to
   the current deadline is not an extension and is rejected. If the current
   deadline has already passed, rule 1 is the one that binds, so an expired
   window can be reopened.
3. **No later than the maturity cutoff.** `due_date` is a date-only column;
   the invoice matures at the end of that day in UTC (23:59:59.999Z), as
   investment eligibility already assumes. A proposal exactly at the cutoff
   is accepted; one millisecond later is not.

**Legacy invoices with no funding deadline** are treated as if the deadline
were now: any future proposal within maturity is an extension.

**At approval** the rules are checked again against the invoice's dates and
the clock at that moment, so a proposal that has expired, or that the
deadline has since overtaken, is not applied. The request stays pending; the
admin rejects it and the seller can then submit a new one.

## One pending request per invoice (#734)

An invoice has at most one pending request. Submissions lock the invoice row
for the length of the check-and-insert, and a partial unique index
(`uq_extension_requests_one_pending_per_invoice` on `invoice_id` where
`status = 'pending'`) enforces it in the database, including for concurrent
requests from several replicas. A losing request gets the same
`409 EXTENSION_PENDING` as a sequential duplicate, and the winner's date and
reason are never overwritten. Reviewed (approved or rejected) requests stay
in the table for audit and do not block a new proposal. Concurrent reviews of
one request are serialized: the second gets `409 EXTENSION_NOT_PENDING`.

Migration `1796100000000-EnforceSinglePendingExtensionRequest` first resolves
existing duplicates: per invoice, the earliest pending request stays pending
and later ones are marked `rejected` with the review note "Superseded
duplicate pending request (issue #734)". Nothing is deleted. Reverting the
migration drops the index but leaves those rows rejected.

## Errors

| Status | Code                           | When                                                        |
| ------ | ------------------------------ | ----------------------------------------------------------- |
| 400    | `MISSING_FIELDS`               | No `proposedDeadline`                                       |
| 400    | `INVALID_DEADLINE`             | Not a valid date, or not in the future                      |
| 403    | `FORBIDDEN`                    | Not the invoice's seller                                    |
| 404    | `INVOICE_NOT_FOUND`            | Unknown invoice                                             |
| 404    | `EXTENSION_NOT_FOUND`          | Unknown request (review)                                    |
| 409    | `EXTENSION_PENDING`            | The invoice already has a pending request                   |
| 409    | `EXTENSION_NOT_PENDING`        | The request was already reviewed (review)                   |
| 409    | `EXTENSION_EXPIRED`            | The proposal passed while awaiting review (approve)         |
| 422    | `EXTENSION_NOT_ALLOWED`        | Invoice is funded, settled, cancelled or rejected           |
| 422    | `EXTENSION_DEADLINE_NOT_LATER` | Not later than the current funding deadline                 |
| 422    | `EXTENSION_BEYOND_MATURITY`    | Later than the maturity cutoff, or the invoice has no maturity |

Errors from the review endpoint keep their status and code; before this
change they were all returned as `500 INTERNAL_ERROR`.
