import { randomUUID } from "crypto";
import type { DataSource } from "typeorm";
import { AuditLogHold } from "../models/AuditLogHold.model";

export const USER_AUDIT_CATEGORY = "user_audit_logs";

const PRODUCTION_RETENTION_DAYS = 365;
const NON_PRODUCTION_RETENTION_DAYS = 30;

export interface AuditRetentionPolicy {
  retentionDays: number;
  batchSize: number;
  maxBatches: number;
}

export type PurgeBatch = (args: {
  runId: string;
  batchIndex: number;
  cutoff: Date;
  batchSize: number;
}) => Promise<number>;

export interface AuditRetentionRunResult {
  runId: string;
  cutoff: Date;
  batches: number;
  deleted: number;
  /** False when the run stopped at `maxBatches` with records still past retention. */
  complete: boolean;
}

function parseBoundedInteger(
  raw: string | undefined,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * Production defaults: 365 days of user audit records, 500 rows per batch,
 * at most 20 batches per run. Every value can be overridden through
 * `AUDIT_RETENTION_DAYS`, `AUDIT_RETENTION_BATCH_SIZE` and
 * `AUDIT_RETENTION_MAX_BATCHES`; see docs/AUDIT_LOG_RETENTION.md.
 */
export function resolveAuditRetentionPolicy(env: NodeJS.ProcessEnv = process.env): AuditRetentionPolicy {
  const defaultDays =
    env.NODE_ENV === "production" ? PRODUCTION_RETENTION_DAYS : NON_PRODUCTION_RETENTION_DAYS;
  return {
    retentionDays: parseBoundedInteger(env.AUDIT_RETENTION_DAYS, "AUDIT_RETENTION_DAYS", 1, 3650, defaultDays),
    batchSize: parseBoundedInteger(env.AUDIT_RETENTION_BATCH_SIZE, "AUDIT_RETENTION_BATCH_SIZE", 1, 5000, 500),
    maxBatches: parseBoundedInteger(env.AUDIT_RETENTION_MAX_BATCHES, "AUDIT_RETENTION_MAX_BATCHES", 1, 1000, 20),
  };
}

export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * Deletes expired records one bounded batch at a time. Each batch is a single
 * statement with its own predicate (age, no active hold), so a run that fails
 * part way can simply be re-run: already-deleted rows are not matched again.
 */
export async function runAuditRetention(args: {
  policy: AuditRetentionPolicy;
  now: Date;
  purgeBatch: PurgeBatch;
  runId?: string;
}): Promise<AuditRetentionRunResult> {
  const runId = args.runId ?? randomUUID();
  const cutoff = retentionCutoff(args.now, args.policy.retentionDays);
  let batches = 0;
  let deleted = 0;

  for (let batchIndex = 1; batchIndex <= args.policy.maxBatches; batchIndex++) {
    const deletedInBatch = await args.purgeBatch({
      runId,
      batchIndex,
      cutoff,
      batchSize: args.policy.batchSize,
    });
    batches += 1;
    deleted += deletedInBatch;
    if (deletedInBatch < args.policy.batchSize) {
      return { runId, cutoff, batches, deleted, complete: true };
    }
  }

  return { runId, cutoff, batches, deleted, complete: false };
}

export function createTypeOrmPurgeBatch(dataSource: DataSource): PurgeBatch {
  return ({ runId, batchIndex, cutoff, batchSize }) =>
    dataSource.transaction(async (manager) => {
      const rows: Array<{ deleted: number }> = await manager.query(
        `
        WITH candidates AS (
          SELECT l.id
          FROM user_audit_logs l
          WHERE l.created_at < $1
            AND NOT EXISTS (
              SELECT 1 FROM audit_log_holds h
              WHERE h.subject_user_id = l.target_user_id AND h.released_at IS NULL
            )
          ORDER BY l.created_at, l.id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        ),
        removed AS (
          DELETE FROM user_audit_logs l
          USING candidates c
          WHERE l.id = c.id
            AND l.created_at < $1
            AND NOT EXISTS (
              SELECT 1 FROM audit_log_holds h
              WHERE h.subject_user_id = l.target_user_id AND h.released_at IS NULL
            )
          RETURNING l.id
        )
        SELECT COUNT(*)::int AS deleted FROM removed
        `,
        [cutoff, batchSize],
      );
      const deleted = rows[0]?.deleted ?? 0;
      if (deleted > 0) {
        await manager.query(
          `INSERT INTO audit_retention_deletions
             (run_id, batch_index, category, cutoff, deleted_count)
           VALUES ($1, $2, $3, $4, $5)`,
          [runId, batchIndex, USER_AUDIT_CATEGORY, cutoff, deleted],
        );
      }
      return deleted;
    });
}

export async function placeAuditHold(
  dataSource: DataSource,
  input: { subjectUserId: string; reason: string; placedByUserId: string | null },
): Promise<AuditLogHold> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new Error("A hold requires a reason");
  }
  const repository = dataSource.getRepository(AuditLogHold);
  return repository.save(
    repository.create({
      subjectUserId: input.subjectUserId,
      placedByUserId: input.placedByUserId,
      reason,
      releasedAt: null,
    }),
  );
}

export async function releaseAuditHold(
  dataSource: DataSource,
  holdId: string,
  now: Date,
): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(holdId)) {
    return false;
  }
  const result = await dataSource
    .createQueryBuilder()
    .update(AuditLogHold)
    .set({ releasedAt: now })
    .where("id = :holdId AND released_at IS NULL", { holdId })
    .execute();
  return (result.affected ?? 0) > 0;
}
