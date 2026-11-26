import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Issue #812: keep ledger, ingestion and processing time apart for indexed
 * events, and quarantine events whose ledger time is invalid.
 *
 * The event retention job moves rows with
 * `INSERT INTO soroban_event_logs_archive SELECT * FROM moved`, so every
 * column added to soroban_event_logs is added to the archive table too, in
 * the same order, or archiving would misalign or fail.
 *
 * No backfill: legacy rows keep their ledger time inside `payload`, and their
 * processing time was never recorded, so lag is unknown (null) for them.
 */
export class SeparateIndexedEventTimestamps1795800000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ["soroban_event_logs", "soroban_event_logs_archive"]) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD COLUMN IF NOT EXISTS "ledger_closed_at" timestamptz,
          ADD COLUMN IF NOT EXISTS "processed_at" timestamptz,
          ADD COLUMN IF NOT EXISTS "quarantine_reason" character varying(64),
          ADD COLUMN IF NOT EXISTS "quarantined_at" timestamptz
      `);
    }
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_soroban_event_logs_quarantined"
      ON "soroban_event_logs" ("quarantined_at")
      WHERE "quarantined_at" IS NOT NULL
    `);
    await queryRunner.query(
      `ALTER TABLE "yield_adjustments" ADD COLUMN IF NOT EXISTS "processed_at" timestamptz`
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "yield_adjustments" DROP COLUMN IF EXISTS "processed_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_soroban_event_logs_quarantined"`);
    for (const table of ["soroban_event_logs", "soroban_event_logs_archive"]) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP COLUMN IF EXISTS "quarantined_at",
          DROP COLUMN IF EXISTS "quarantine_reason",
          DROP COLUMN IF EXISTS "processed_at",
          DROP COLUMN IF EXISTS "ledger_closed_at"
      `);
    }
  }
}
