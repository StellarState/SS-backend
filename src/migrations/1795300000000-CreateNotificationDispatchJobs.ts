import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * #772 — durable lifecycle notification jobs.
 *
 * Rows are persisted before `enqueue()` is acknowledged, claimed atomically by
 * one worker, and deleted on delivery. Failed attempts and their next-attempt
 * time live in the row, and terminal failures are retained for inspection and
 * deliberate replay.
 */
export class CreateNotificationDispatchJobs1795300000000 implements MigrationInterface {
  name = "CreateNotificationDispatchJobs1795300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_dispatch_jobs" (
        "event_id" character varying(191) NOT NULL,
        "event" jsonb NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'pending',
        "attempts" integer NOT NULL DEFAULT 0,
        "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "claimed_by" character varying(64),
        "claimed_at" TIMESTAMPTZ,
        "last_error" text,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_dispatch_jobs" PRIMARY KEY ("event_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_notification_dispatch_jobs_due" ON "notification_dispatch_jobs" ("status", "next_attempt_at")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_notification_dispatch_jobs_claim" ON "notification_dispatch_jobs" ("status", "claimed_at")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_notification_dispatch_jobs_updated" ON "notification_dispatch_jobs" ("updated_at")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_dispatch_jobs"`);
  }
}
