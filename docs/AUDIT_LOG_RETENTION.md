# Audit-log retention

User audit records (`user_audit_logs`) are purged once they are older than the
retention window. Purging runs in bounded batches and never removes a record
for a user under an active legal hold.

## Defaults

| Setting | Production (`NODE_ENV=production`) | Other environments |
| --- | --- | --- |
| `AUDIT_RETENTION_DAYS` | 365 | 30 |
| `AUDIT_RETENTION_BATCH_SIZE` | 500 (max 5000) | 500 |
| `AUDIT_RETENTION_MAX_BATCHES` | 20 per run (max 1000) | 20 |

Invalid values stop the command with an error naming the variable.

## Running a purge

```powershell
npm run audit:retention -- run
```

The command prints the run id, cutoff, batches executed, rows deleted and
whether the run finished. It exits with status 2 when `maxBatches` was reached
with expired rows still remaining. Run it again to continue.

Schedule it from cron or your orchestrator at a quiet period, once a day is
enough for the default volumes.

## Holds

Place a hold when records for a user must be kept beyond the retention window
(for example during a dispute or an investigation):

```powershell
npm run audit:retention -- hold <userId> "dispute 2026-114"
npm run audit:retention -- release <holdId>
```

While a hold is active, no `user_audit_logs` row for that user is deleted. The
hold does not stop new records being written.

## Guarantees

- **Bounded:** each batch is one transaction deleting at most `batchSize` rows.
- **Retryable:** every batch predicate is "older than cutoff and not held". A
  failed run can be re-run; rows already removed are not matched again.
- **Idempotent:** running again over already-purged data deletes nothing.
- **Audited:** each batch that deletes rows writes one row to
  `audit_retention_deletions` (run id, batch index, category, cutoff, count).
  Those rows are not subject to this purge.
- **Held records preserved:** the hold check is repeated inside the delete
  statement, so a hold placed while a batch is running still protects its rows
  unless the delete had already committed.

## Metrics and monitoring

Each run prints a JSON summary. Alert when a run reports `"complete": false`
on consecutive days, which means the backlog is growing faster than the batch
limit clears it.
