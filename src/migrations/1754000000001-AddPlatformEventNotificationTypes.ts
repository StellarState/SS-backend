import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Notification types for the platform events of issue #564.
 *
 * `invoice_approved` and `listing_sold` are new. `settlement_received`,
 * `kyc_approved` and `kyc_rejected` were already in the NotificationType enum
 * in code but never added to the database type, so inserting them failed.
 */
export class AddPlatformEventNotificationTypes1754000000001 implements MigrationInterface {
  name = "AddPlatformEventNotificationTypes1754000000001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of [
      "invoice_approved",
      "listing_sold",
      "settlement_received",
      "kyc_approved",
      "kyc_rejected",
    ]) {
      await queryRunner.query(
        `ALTER TYPE "public"."notifications_notificationtype_enum" ADD VALUE IF NOT EXISTS '${value}';`
      );
    }
  }

  public async down(): Promise<void> {
    // Postgres cannot drop enum values; rows may already use them. Mirrors
    // AddInvoiceLifecycleNotificationTypes1732500000000, which is also additive-only.
  }
}
