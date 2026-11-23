import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPayoutSnapshotsAndStatements1795500000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE "dividend_snapshots" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "contract_id" varchar(128) NOT NULL, "cycle_id" varchar(128) NOT NULL,
      "revision" integer NOT NULL CHECK (revision > 0), "issuer_wallet" varchar(56) NOT NULL,
      "snapshot_hash" varchar(64) NOT NULL, "allocations" text NOT NULL,
      "total_amount" decimal(18,4) NOT NULL, "contract_total" decimal(18,4), "contract_claimed" decimal(18,4),
      "is_current" boolean NOT NULL DEFAULT true, "locked" boolean NOT NULL DEFAULT false, "cycle_frequency" varchar(20), "tx_hash" varchar(64),
      "ledger_sequence" bigint, "distributed_at" timestamptz NOT NULL,
      "reconciliation_status" varchar(20) NOT NULL DEFAULT 'pending', "retry_count" integer NOT NULL DEFAULT 0,
      "retry_at" timestamptz, "report" text, "created_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "uq_dividend_snapshot_revision" UNIQUE (contract_id, cycle_id, revision))`);
    await q.query(`CREATE TABLE "payout_attempts" (
      "key" varchar(64) PRIMARY KEY, "kind" varchar(20) NOT NULL, "wallet" varchar(56) NOT NULL,
      "cycle_id" varchar(128) NOT NULL, "revision" integer NOT NULL CHECK (revision > 0),
      "snapshot_id" uuid REFERENCES dividend_snapshots(id),
      "gross" decimal(18,4) NOT NULL, "platform_fee" decimal(18,4) NOT NULL, "net" decimal(18,4) NOT NULL,
      "status" varchar(20) NOT NULL DEFAULT 'pending', "tx_hash" varchar(64), "failure_code" varchar(64), "last_checked_at" timestamptz,
      "created_at" timestamptz NOT NULL DEFAULT now())`);
    await q.query(
      `ALTER TABLE "dividend_distributions" ADD COLUMN "snapshot_id" uuid UNIQUE REFERENCES dividend_snapshots(id)`
    );
    await q.query(
      `ALTER TABLE "dividend_allocations" ADD COLUMN "snapshot_id" uuid REFERENCES dividend_snapshots(id), ADD COLUMN "revision" integer NOT NULL DEFAULT 1`
    );
    await q.query(
      `ALTER TABLE "dividend_claims" ADD COLUMN "snapshot_id" uuid REFERENCES dividend_snapshots(id), ADD COLUMN "revision" integer NOT NULL DEFAULT 1, ADD COLUMN "idempotency_key" varchar(64) UNIQUE REFERENCES payout_attempts(key)`
    );
    await q.query(
      `ALTER TABLE "royalty_events" ADD COLUMN "statement_sequence" BIGSERIAL UNIQUE, ADD COLUMN "event_id" varchar(64) UNIQUE, ADD COLUMN "cycle_id" varchar(128), ADD COLUMN "cycle_at" timestamptz, ADD COLUMN "revision" integer NOT NULL DEFAULT 1, ADD COLUMN "gross" decimal(18,4), ADD COLUMN "platform_fee" decimal(18,4) NOT NULL DEFAULT 0`
    );
    await q.query(
      `UPDATE "royalty_events" SET "cycle_at" = COALESCE(paid_at, created_at), "gross" = amount`
    );
    await q.query(
      `ALTER TABLE "royalty_claims" ADD COLUMN "cycle_id" varchar(128), ADD COLUMN "revision" integer NOT NULL DEFAULT 1, ADD COLUMN "idempotency_key" varchar(64) UNIQUE REFERENCES payout_attempts(key)`
    );
    await q.query(
      `CREATE INDEX "idx_royalty_statement_cursor" ON "royalty_events" (creator_wallet, statement_sequence DESC)`
    );
    await q.query(
      `CREATE INDEX "idx_dividend_reconciliation_due" ON "dividend_snapshots" (reconciliation_status, retry_at)`
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "idx_royalty_statement_cursor"`);
    await q.query(
      `ALTER TABLE "royalty_claims" DROP COLUMN "idempotency_key", DROP COLUMN "revision", DROP COLUMN "cycle_id"`
    );
    await q.query(
      `ALTER TABLE "royalty_events" DROP COLUMN "platform_fee", DROP COLUMN "gross", DROP COLUMN "revision", DROP COLUMN "cycle_at", DROP COLUMN "cycle_id", DROP COLUMN "event_id", DROP COLUMN "statement_sequence"`
    );
    await q.query(
      `ALTER TABLE "dividend_claims" DROP COLUMN "idempotency_key", DROP COLUMN "revision", DROP COLUMN "snapshot_id"`
    );
    await q.query(
      `ALTER TABLE "dividend_allocations" DROP COLUMN "revision", DROP COLUMN "snapshot_id"`
    );
    await q.query(`ALTER TABLE "dividend_distributions" DROP COLUMN "snapshot_id"`);
    await q.query(`DROP TABLE "payout_attempts"`);
    await q.query(`DROP TABLE "dividend_snapshots"`);
  }
}
