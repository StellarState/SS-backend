import { randomUUID } from "crypto";
import type { DataSource } from "typeorm";
import { recordReliabilityMetric } from "../observability/reliability-metrics";
import { logger } from "../observability/logger";

export type RetentionSource = "soroban_event_logs" | "webhook_delivery_logs";
export interface RetentionPolicy {
  hotDays: number;
  archiveDays: number;
  batchSize: number;
  maxBatches: number;
  statementTimeoutMs: number;
}
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  hotDays: 30,
  archiveDays: 365,
  batchSize: 500,
  maxBatches: 10,
  statementTimeoutMs: 5000,
};

/** One operator invocation is bounded by rows, batches, lock wait and statement time. */
export async function maintainEventRetention(
  source: RetentionSource,
  dataSource: DataSource,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
  now = new Date()
): Promise<{ archived: number; purged: number; correlationId: string }> {
  if (
    !["soroban_event_logs", "webhook_delivery_logs"].includes(source) ||
    !Number.isFinite(now.getTime()) ||
    !Object.values(policy).every((value) => Number.isSafeInteger(value) && value > 0) ||
    policy.archiveDays <= policy.hotDays ||
    policy.batchSize > 1000 ||
    policy.maxBatches > 100 ||
    policy.statementTimeoutMs > 30000
  ) {
    throw new Error("Invalid or unbounded event retention policy");
  }
  const result = { archived: 0, purged: 0, correlationId: randomUUID() };
  for (const action of ["archive", "purge"] as const) {
    const table = action === "archive" ? source : `${source}_archive`;
    const days = action === "archive" ? policy.hotDays : policy.archiveDays;
    const cutoff = new Date(now.getTime() - days * 86400000);
    for (let batch = 0; batch < policy.maxBatches; batch++) {
      const started = Date.now();
      const count = await dataSource.transaction(async (manager) => {
        await manager.query(`SET LOCAL statement_timeout = '${policy.statementTimeoutMs}ms'`);
        await manager.query(`SET LOCAL lock_timeout = '1000ms'`);
        const eligible =
          source === "soroban_event_logs"
            ? `AND processed = true AND EXISTS (SELECT 1 FROM soroban_indexer_checkpoints c
              WHERE c.checkpoint_key = t.contract_id AND c.ledger_sequence > t.ledger_sequence)`
            : "";
        const rows: Array<{ id: string }> = await manager.query(
          `
          SELECT t.id FROM "${table}" t WHERE created_at < $1 ${eligible}
          ORDER BY created_at, id LIMIT $2 FOR UPDATE OF t SKIP LOCKED`,
          [cutoff, policy.batchSize]
        );
        if (!rows.length) return 0;
        const ids = rows.map((row) => row.id);
        if (action === "archive") {
          const scope = source === "soroban_event_logs" ? "contract_id" : "subscription_id::text";
          const terminal = source === "soroban_event_logs" ? "processed" : "delivered";
          await manager.query(
            `INSERT INTO event_replay_receipts (source, scope, event_id)
            SELECT $1, ${scope}, event_id FROM "${source}"
            WHERE id = ANY($2::uuid[]) AND ${terminal} = true AND event_id IS NOT NULL
            ON CONFLICT DO NOTHING`,
            [source, ids]
          );
          await manager.query(
            `WITH moved AS (DELETE FROM "${source}" WHERE id = ANY($1::uuid[]) RETURNING *)
            INSERT INTO "${source}_archive" SELECT * FROM moved`,
            [ids]
          );
        } else {
          await manager.query(`DELETE FROM "${table}" WHERE id = ANY($1::uuid[])`, [ids]);
        }
        await manager.query(
          `INSERT INTO event_retention_audit
          (correlation_id, source, action, cutoff, row_count, duration_ms) VALUES ($1,$2,$3,$4,$5,$6)`,
          [result.correlationId, source, action, cutoff, rows.length, Date.now() - started]
        );
        return rows.length;
      });
      recordReliabilityMetric(`event_retention_${source}_${action}_rows`, count);
      result[action === "archive" ? "archived" : "purged"] += count;
      if (count < policy.batchSize) break;
    }
  }
  logger.info("event.retention.completed", { source, ...result });
  return result;
}
