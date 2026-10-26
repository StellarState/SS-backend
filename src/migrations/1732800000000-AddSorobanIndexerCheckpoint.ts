import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSorobanIndexerCheckpoint1732800000000 implements MigrationInterface {
  name = "AddSorobanIndexerCheckpoint1732800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "soroban_event_logs"
      ADD COLUMN IF NOT EXISTS "event_id" character varying(255)
    `);

    await queryRunner.query(`
      ALTER TABLE "soroban_event_logs"
      ALTER COLUMN "event_id" TYPE character varying(255)
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "public"."idx_soroban_event_logs_event_id"
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_soroban_event_logs_contract_event"
      ON "soroban_event_logs" ("contract_id", "event_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "soroban_indexer_checkpoints" (
        "checkpoint_key" character varying(255) NOT NULL,
        "ledger_sequence" bigint NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_soroban_indexer_checkpoints" PRIMARY KEY ("checkpoint_key")
      )
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'soroban_indexer_checkpoints' AND column_name = 'indexer_id'
        ) THEN
          ALTER TABLE "soroban_indexer_checkpoints" RENAME COLUMN "indexer_id" TO "checkpoint_key";
          ALTER TABLE "soroban_indexer_checkpoints" ALTER COLUMN "checkpoint_key" TYPE character varying(255);
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "soroban_indexer_checkpoints"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."uq_soroban_event_logs_contract_event"`);
    await queryRunner.query(`ALTER TABLE "soroban_event_logs" DROP COLUMN IF EXISTS "event_id"`);
  }
}
