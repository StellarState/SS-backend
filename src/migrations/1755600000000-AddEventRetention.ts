import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddEventRetention1755600000000 implements MigrationInterface {
  transaction = false;

  async up(runner: QueryRunner): Promise<void> {
    const invalidIndexes: Array<{ index_name: string }> = await runner.query(
      `SELECT c.relname AS index_name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND NOT i.indisvalid AND c.relname = ANY($1)`,
      [
        [
          "idx_soroban_event_logs_retention",
          "idx_webhook_delivery_logs_retention",
          "idx_soroban_event_logs_archive_retention",
          "idx_webhook_delivery_logs_archive_retention",
          "idx_soroban_events_contract_time",
          "idx_soroban_events_cleanup",
          "idx_webhook_delivery_subscription_time",
          "idx_webhook_delivery_dedup",
          "idx_event_retention_audit_time",
        ],
      ]
    );
    for (const { index_name } of invalidIndexes) {
      await runner.query(`DROP INDEX CONCURRENTLY "${index_name}"`);
    }
    for (const table of ["soroban_event_logs", "webhook_delivery_logs"]) {
      await runner.query(
        `CREATE TABLE IF NOT EXISTS "${table}_archive" (LIKE "${table}" INCLUDING ALL)`
      );
      await runner.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_${table}_retention" ON "${table}" (created_at, id)`
      );
      await runner.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_${table}_archive_retention" ON "${table}_archive" (created_at, id)`
      );
    }
    await runner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_soroban_events_contract_time ON soroban_event_logs (contract_id, created_at, id)`
    );
    await runner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_soroban_events_cleanup ON soroban_event_logs (created_at, id) WHERE processed = true`
    );
    await runner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhook_delivery_subscription_time ON webhook_delivery_logs (subscription_id, created_at, id)`
    );
    await runner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhook_delivery_dedup ON webhook_delivery_logs (subscription_id, event_id) WHERE delivered = true`
    );
    await runner.query(`CREATE TABLE IF NOT EXISTS event_replay_receipts (
      source varchar(32) NOT NULL, scope varchar(255) NOT NULL, event_id varchar(255) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (source, scope, event_id))`);
    await runner.query(`CREATE TABLE IF NOT EXISTS event_retention_audit (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), correlation_id uuid NOT NULL,
      source varchar(32) NOT NULL, action varchar(16) NOT NULL,
      cutoff timestamptz NOT NULL, row_count integer NOT NULL,
      duration_ms integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
    await runner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_retention_audit_time ON event_retention_audit (created_at, id)`
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    const ownTransaction = !runner.isTransactionActive;
    if (ownTransaction) await runner.startTransaction();
    try {
      // Restore before dropping archives; FK violations deliberately abort rollback.
      for (const table of ["soroban_event_logs", "webhook_delivery_logs"]) {
        await runner.query(
          `INSERT INTO "${table}" SELECT * FROM "${table}_archive" ON CONFLICT (id) DO NOTHING`
        );
        await runner.query(`DROP TABLE "${table}_archive"`);
        await runner.query(`DROP INDEX "idx_${table}_retention"`);
      }
      for (const index of [
        "idx_soroban_events_contract_time",
        "idx_soroban_events_cleanup",
        "idx_webhook_delivery_subscription_time",
        "idx_webhook_delivery_dedup",
      ]) {
        await runner.query(`DROP INDEX "${index}"`);
      }
      if (ownTransaction) await runner.commitTransaction();
    } catch (error) {
      if (ownTransaction) await runner.rollbackTransaction();
      throw error;
    }
    // Receipts and audit survive rollback: purged payloads are irreversible, but
    // their replay protection and maintenance evidence must never be discarded.
  }
}
