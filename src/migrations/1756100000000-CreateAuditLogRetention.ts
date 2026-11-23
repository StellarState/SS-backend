import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Issue #823 — audit-log retention: operational holds that protect a user's
 * records from purge, and an audit trail of every purge batch.
 */
export class CreateAuditLogRetention1756100000000 implements MigrationInterface {
  name = "CreateAuditLogRetention1756100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_user_audit_logs_created_at"
      ON "user_audit_logs" ("created_at");
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "audit_log_holds" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "subject_user_id" uuid NOT NULL,
        "placed_by_user_id" uuid,
        "reason" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "released_at" timestamptz
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_audit_log_holds_subject_active"
      ON "audit_log_holds" ("subject_user_id") WHERE "released_at" IS NULL;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "audit_retention_deletions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "run_id" uuid NOT NULL,
        "batch_index" integer NOT NULL,
        "category" varchar(64) NOT NULL,
        "cutoff" timestamptz NOT NULL,
        "deleted_count" integer NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_audit_retention_deletions_run"
      ON "audit_retention_deletions" ("run_id", "batch_index");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_retention_deletions";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_log_holds";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_user_audit_logs_created_at";`);
  }
}
