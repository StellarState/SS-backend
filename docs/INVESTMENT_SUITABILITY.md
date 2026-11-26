# Investment suitability gate (issue #741)

Suitability validation is a **required precondition** for every investment
commitment (`POST /api/v1/investments` and `POST /api/v1/invoices/:id/invest`).
The check runs before the funding transaction, so a failed or timed-out lookup
can never create an investment, advance `invoices.funded_amount`, or emit
post-commit notifications.

## Outcomes

| Outcome | HTTP | Code | Meaning |
| --- | --- | --- | --- |
| Suitable profile | 201 | — | Funding proceeds normally. |
| Evaluated but ineligible (no profile or tier/category mismatch) | 403 | `SUITABILITY_CHECK_FAILED` | Business decision; retrying does not help. |
| Profile/invoice lookup failed, timed out, or returned unexpected data | 503 | `SUITABILITY_CHECK_UNAVAILABLE` | Dependency failure with `details.retryable: true` and `Retry-After: 1`. |

The 403 and 503 paths are deliberately distinct: an unexpected exception must
never be interpreted as "suitable", and it must never be interpreted as a
business rejection either.

## Logging

Dependency failures are logged as `investment.suitability_check_unavailable`
with only a truncated investor wallet, invoice id, error class, and duration.
Questionnaire responses, risk-profile documents, and raw error payloads are
never logged.

## Explicitly disabling the gate

`REQUIRE_INVESTMENT_SUITABILITY=false` is the only supported way to disable
suitability. In that mode the service does not perform the lookup at all and
logs `investment.suitability_disabled`. Omitting the risk-profile service in
tests/composition is equivalent. A runtime exception is never treated as a
request to disable the gate.

`INVESTMENT_SUITABILITY_LOOKUP_TIMEOUT_MS` (default `5000`) bounds each
dependency lookup. A timeout fails closed with the retryable 503 above.
