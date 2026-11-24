import { MigrationInterface, QueryRunner } from "typeorm";
import { logger } from "../observability/logger";
import { AppError } from "../utils/http-error";

const MIGRATION_NAME = "CreateAuditLogsTable1755000000000";

/**
 * Creates the append-only audit_logs table for sensitive admin and financial actions (#869)
 * and revokes UPDATE and DELETE permissions from PUBLIC.
 */
export class CreateAuditLogsTable1755000000000 implements MigrationInterface {
  name = MIGRATION_NAME;

  public async up(queryRunner: QueryRunner): Promise<void> {
    try {
      logger.info("migration.start", { name: MIGRATION_NAME, direction: "up" });

      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "audit_logs" (
          "id" BIGSERIAL PRIMARY KEY,
          "actor" VARCHAR(128) NOT NULL,
          "action" VARCHAR(128) NOT NULL,
          "resource" VARCHAR(255) NOT NULL,
          "before" JSONB,
          "after" JSONB,
          "prev_hash" VARCHAR(64) NOT NULL,
          "hash" VARCHAR(64) NOT NULL UNIQUE,
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "idx_audit_logs_actor_id" ON "audit_logs" ("actor", "id")`
      );
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "idx_audit_logs_action_id" ON "audit_logs" ("action", "id")`
      );
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "idx_audit_logs_resource_id" ON "audit_logs" ("resource", "id")`
      );

      await queryRunner.query(`REVOKE UPDATE, DELETE ON TABLE "audit_logs" FROM PUBLIC`);

      logger.info("migration.complete", { name: MIGRATION_NAME, direction: "up" });
    } catch (error) {
      logger.error("migration.failed", { name: MIGRATION_NAME, direction: "up", error });
      const message = error instanceof Error ? error.message : String(error);
      throw new AppError(
        500,
        `Migration "${MIGRATION_NAME}" failed: ${message}`,
        "MIGRATION_FAILED",
        {
          name: MIGRATION_NAME,
        }
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    try {
      logger.info("migration.start", { name: MIGRATION_NAME, direction: "down" });
      await queryRunner.query(`DROP TABLE IF EXISTS "audit_logs"`);
      logger.info("migration.complete", { name: MIGRATION_NAME, direction: "down" });
    } catch (error) {
      logger.error("migration.failed", { name: MIGRATION_NAME, direction: "down", error });
      const message = error instanceof Error ? error.message : String(error);
      throw new AppError(
        500,
        `Migration "${MIGRATION_NAME}" rollback failed: ${message}`,
        "MIGRATION_ROLLBACK_FAILED",
        { name: MIGRATION_NAME }
      );
    }
  }
}
