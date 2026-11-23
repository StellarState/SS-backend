import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Issue #853 — per-login session records so individual sessions can be listed
 * and revoked. Stores redacted device and network metadata only.
 */
export class CreateWalletSessions1756000000000 implements MigrationInterface {
  name = "CreateWalletSessions1756000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "wallet_sessions" (
        "id" uuid PRIMARY KEY,
        "wallet" varchar(56) NOT NULL,
        "device_label" varchar(120) NOT NULL,
        "network_prefix" varchar(64),
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "expires_at" timestamptz NOT NULL,
        "revoked_at" timestamptz
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_wallet_sessions_wallet_created"
      ON "wallet_sessions" ("wallet", "created_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_wallet_sessions_wallet_created";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "wallet_sessions";`);
  }
}
