# KYC attempt and callback semantics (issues #737, #738, #739)

## Active attempt invariant

At most one **active** verification (`pending`, `in_review`, or `approved`) may
exist per user and verification type, and per wallet and verification type.
PostgreSQL enforces this with partial unique indexes introduced by migration
`1796200000000-EnforceSingleActiveKycAttempt`. Every state-changing KYC
operation takes a transaction-scoped advisory lock keyed by user id, so
concurrent first submissions and resubmissions are serialized across API
replicas. A losing race is mapped to **HTTP 409** and performs no writes to the
winning attempt.

The current attempt is always selected deterministically by `created_at DESC,
id DESC`. `verified_at` is not used because pending attempts have no
`verified_at`.

## Webhook decisions

Provider callbacks are bound to a specific attempt:

- `verificationId` (when supplied) must identify a verification belonging to
  the callback user and that user's current attempt for the verification type.
- `wallet` and `providerReference` (when supplied) must match the stored
  attempt.
- The status comparison, verification update, history insert, user update, and
  webhook-event completion all happen in one locked transaction.

Outcomes:

| Situation | Result |
| --- | --- |
| First decision on a pending attempt | Applied; user/verification/history updated; 204 |
| Replay of the identical decision for the same attempt | Idempotent: 204, no extra history row and no duplicate notification |
| Opposing decision for an already-decided attempt | 409; existing compliance state unchanged |
| Callback for an archived/older attempt (e.g. after resubmission) | 409; the current attempt is untouched |
| Callback for unknown user/attempt | 404 |

Ordering is enforced by state comparison, not by wallet/identity validation;
identity checks are a separate defence.

## Rejection reasons and history

- A webhook rejection stores the exact provider reason in
  `kyc_verifications.documents.rejectionReason` and in the history row, both
  labelled with the **resulting** `rejected` state. `GET /kyc/status` therefore
  returns the exact reason on the first rejection.
- Approval clears any stale `rejectionReason`/`reason` on the current attempt.
- Resubmission archives the previous decision (keeping its reason) and creates
  a fresh pending attempt with `rejectionReason: null`.
- Missing optional provider reasons are stored as `null` explicitly.
- Every history row describes the decision that produced it (`pending` rows are
  never used as reason containers).
