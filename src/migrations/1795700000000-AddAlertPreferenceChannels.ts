import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Issue #811: per-event delivery channels on investor alert preferences.
 * Nullable so existing rows keep the default channels until a wallet opts in.
 */
export class AddAlertPreferenceChannels1795700000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "alert_preferences" ADD COLUMN "channels" jsonb`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "alert_preferences" DROP COLUMN "channels"`);
  }
}
