import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates the referral_earnings table to store indexed ReferralRewardPaid on-chain events.
 * Powers GET /referrals/:wallet/stats and GET /referrals/:wallet/earnings endpoints.
 */
export class CreateReferralEarnings1795300000000 implements MigrationInterface {
  name = "CreateReferralEarnings1795300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "referral_earnings" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "event_id" varchar(128),
        "referrer_wallet" varchar(56) NOT NULL,
        "referred_wallet" varchar(56) NOT NULL,
        "amount" decimal(18,4) NOT NULL,
        "tx_hash" varchar(64),
        "ledger_sequence" bigint,
        "earned_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_referral_earnings_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_referral_earnings_event_id" UNIQUE ("event_id")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_referral_earnings_referrer_wallet"
      ON "referral_earnings" ("referrer_wallet");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_referral_earnings_referred_wallet"
      ON "referral_earnings" ("referred_wallet");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_referral_earnings_earned_at"
      ON "referral_earnings" ("earned_at");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_referral_earnings_referrer_earned_id"
      ON "referral_earnings" ("referrer_wallet", "earned_at" DESC, "id" DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_referral_earnings_tx_hash"
      ON "referral_earnings" ("tx_hash");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_referral_earnings_tx_hash";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_referral_earnings_referrer_earned_id";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_referral_earnings_earned_at";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_referral_earnings_referred_wallet";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_referral_earnings_referrer_wallet";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "referral_earnings";`);
  }
}
