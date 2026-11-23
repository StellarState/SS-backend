# Settlement SLA and lag metrics

Exposed on the existing `/metrics` endpoint in Prometheus text format. Labels carry only stage or outcome names. Wallet addresses and invoice identifiers are never used as labels or values.

## Metrics

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `stellarsettle_settlement_stage_count` | gauge | `stage` (`pending`, `in_progress`) | `pending`: matured invoices awaiting settlement in the last worker cycle. `in_progress`: settlement flows currently running. |
| `stellarsettle_settlement_oldest_pending_age_seconds` | gauge | none | Age of the oldest matured invoice still pending, measured from its due date. |
| `stellarsettle_settlement_transitions_total` | counter | `outcome` (`completed`, `failed`) | Settlement flows reaching a terminal outcome. |
| `stellarsettle_settlement_retries_total` | counter | none | Matured settlements that failed in a worker cycle and will be retried. |
| `stellarsettle_settlement_queue_latency_seconds` | histogram | none | Seconds between an invoice's due date and the start of its settlement attempt. |

Histogram buckets (seconds): 1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 21600, 86400.

Ledger confirmation latency is not exposed: the current settlement flow has no ledger distribution step to time.

## Suggested alert thresholds

| Alert | Condition | Severity |
| --- | --- | --- |
| Settlement backlog aging | `stellarsettle_settlement_oldest_pending_age_seconds > 3600` for 15m | warning |
| Settlement backlog critical | `stellarsettle_settlement_oldest_pending_age_seconds > 21600` for 15m | critical |
| Settlement failures rising | `rate(stellarsettle_settlement_transitions_total{outcome="failed"}[15m]) > 0` sustained for 30m | warning |
| Retries stuck | `increase(stellarsettle_settlement_retries_total[1h]) > 10` | warning |
| Slow queue pickup | `histogram_quantile(0.95, rate(stellarsettle_settlement_queue_latency_seconds_bucket[30m])) > 3600` | warning |

Thresholds are starting points. Tune them against observed settlement volume.

## Behaviour

- Metric updates never throw into the settlement flow. When no registry is configured, updates are no-ops, so health endpoints are unaffected.
- `in_progress` is incremented when a settlement starts and decremented on completion or failure. It never goes below zero.
