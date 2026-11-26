import { MigrationInterface, QueryRunner } from "typeorm";

export class UniqueReferralTierHistoryEvents1796200000000 implements MigrationInterface {
  name = "UniqueReferralTierHistoryEvents1796200000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_referral_tier_history_event_id" ON "referral_tier_history" ("last_event_id") WHERE "last_event_id" IS NOT NULL`
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_referral_tier_history_event_id"`);
  }
}
