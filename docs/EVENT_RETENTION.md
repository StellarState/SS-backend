# Event storage lifecycle

Soroban and webhook logs use reversible B-tree indexes and separate archive
relations. Hot-table indexes are built concurrently so normal writes can continue. An
interrupted build can be retried; the migration removes its invalid index before
rebuilding. Archive restoration runs transactionally on rollback. Online time partitioning is deliberately deferred: PostgreSQL requires
partition keys in unique constraints, which would weaken existing event identity.
This migration keeps the primary tables and their unique keys intact.

| Tier | Age | Storage and access |
| --- | --- | --- |
| Hot | 0–30 days | Existing event tables, indexed by time and ID |
| Archive | 30–365 days | Matching archive tables, indexed by time and ID |
| Purge | Older than 365 days | Payload deleted; transactional audit remains |

Only processed Soroban rows strictly behind their contract's durable checkpoint
can move or purge. Pending events and contracts without checkpoints remain hot.
Webhook attempts have completed synchronously before being logged. Compact
`event_replay_receipts` retain successful `(source, scope, event_id)` identities
for the lifetime of the contract/subscription, including after payload purge.
They intentionally have no foreign key cascade. Do not delete receipts while
historical events can be replayed. Audit rows are retained independently.

## Maintenance

Run `maintainEventRetention(source, dataSource)` from a scheduled operator job
using the application DataSource, or schedule `NODE_ENV=test node -r ts-node/register scripts/maintain-events.ts` from a source checkout (from a source checkout, this selects PostgreSQL and TypeScript entities; a packaged deployment should run the compiled equivalent with its configured entity paths). The CLI emits per-run counters for an operator metrics collector. Default policy is exported from
`src/maintenance/event-retention.ts`. Schedule hourly and use a single invocation
per table; concurrent invocations use `FOR UPDATE SKIP LOCKED`.
Each invocation archives at most 5,000 and purges at most 5,000 rows, in 500-row
transactions. Hard limits are 1,000 rows/batch, 100 batches/phase, and 30 seconds
per statement; defaults are five seconds per statement and one second lock wait.
Movement, replay receipts and audit insert commit together. An audit failure rolls
back the entire batch. Restarting resumes from the oldest remaining eligible row.
Schedule without overlapping invocations to bound total database load.

Query hot/archive separately with an explicit time range and stable cursor:
`WHERE contract_id = $1 AND created_at >= $2 AND created_at < $3
AND (created_at, id) > ($4, $5) ORDER BY created_at, id LIMIT $6`.
Use `subscription_id` for webhook scope. Never load all history into an API.
Replay lookups use unique receipt keys or the delivered webhook composite index.

Monitor `stellarsettle_event_retention_<table>_<archive|purge>_rows_total`,
`event.retention.completed` logs and `event_retention_audit` (correlation ID,
cutoff, count, duration). Alert on sustained zero progress with eligible backlog,
repeated statement timeouts, excessive transaction duration and archive growth.
Inspect backlog using the oldest eligible indexed row, not repeated full counts.
Run ANALYZE after major movement; monitor autovacuum, dead tuples, WAL volume,
replication lag and relation size through pg_stat_user_tables/pg_stat_all_indexes.

## Validation and rollback

Run `DATABASE_URL=... npm test -- --runInBand event-retention` on PostgreSQL.
The integration benchmark seeds 100,000 rows, runs ANALYZE and EXPLAIN ANALYZE
with buffers, prints the plan and rejects sequential scans for a selective
subscription/time query. Run on production-sized staging data before changing
retention periods; compare execution time, buffers and row estimates.

Stop maintenance before `db:migrate:revert`. The down migration restores archive
rows into hot tables and removes only the added indexes/archive relations.
Receipts and audit survive rollback and reapplication. Purged payloads require
backup recovery. If a webhook subscription was deleted, restoring its logs may
violate the original foreign key: rollback aborts without discarding data;
restore the subscription from backup or export those archive rows first.
Budget disk/WAL headroom for restoration. Verify row counts and sampled payloads
before restarting the previous binary.

For future monthly RANGE partitions, stage a shadow table, preserve replay
receipts independently, backfill in bounded time batches, dual write, verify
counts/checksums and EXPLAIN partition pruning, then switch readers. Keep the
original relation and dual writes throughout the rollback window. Revert readers
and reconcile new rows before removing the shadow table. Never drop a partition
until archive export and its audited checksum are verified.

Local benchmark result (100,000 rows, PostgreSQL 18.6, warm local buffers):
index-only scan, 9 result rows, 4 shared buffers, 0.059 ms execution. This is a
reproducibility sample, not a production latency guarantee.
