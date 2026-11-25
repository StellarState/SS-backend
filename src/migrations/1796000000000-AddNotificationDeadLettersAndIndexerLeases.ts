import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddNotificationDeadLettersAndIndexerLeases1796000000000
  implements MigrationInterface
{
  name = "AddNotificationDeadLettersAndIndexerLeases1796000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_dispatch_jobs"
      ADD COLUMN IF NOT EXISTS "correlation_id" character varying(128)
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_dead_letter_audits" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "event_id" character varying(191) NOT NULL,
        "actor_id" character varying(128) NOT NULL,
        "action" character varying(16) NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_dead_letter_audits" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_notification_dead_letter_audits_action"
          CHECK ("action" IN ('replayed', 'discarded'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notification_dead_letter_audits_event_created"
      ON "notification_dead_letter_audits" ("event_id", "created_at")
    `);
    await queryRunner.query(`
      ALTER TABLE "soroban_indexer_checkpoints"
      ADD COLUMN IF NOT EXISTS "lease_owner" character varying(128)
    `);
    await queryRunner.query(`
      ALTER TABLE "soroban_indexer_checkpoints"
      ADD COLUMN IF NOT EXISTS "lease_expires_at" TIMESTAMPTZ
    `);
    await queryRunner.query(`
      ALTER TABLE "soroban_indexer_checkpoints"
      ADD COLUMN IF NOT EXISTS "fencing_token" bigint NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "soroban_indexer_checkpoints" DROP COLUMN "fencing_token"`);
    await queryRunner.query(`ALTER TABLE "soroban_indexer_checkpoints" DROP COLUMN "lease_expires_at"`);
    await queryRunner.query(`ALTER TABLE "soroban_indexer_checkpoints" DROP COLUMN "lease_owner"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_dead_letter_audits"`);
    await queryRunner.query(
      `ALTER TABLE "notification_dispatch_jobs" DROP COLUMN "correlation_id"`
    );
  }
}
