import { MigrationInterface, QueryRunner, Table, TableColumn, TableIndex } from "typeorm";

export class AddWaitlistReferralCredits1795200000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn("waitlist_entries", new TableColumn({
      name: "referred_by_code",
      type: "varchar",
      length: "64",
      isNullable: true,
    }));

    await queryRunner.createTable(new Table({
      name: "waitlist_referral_credits",
      columns: [
        { name: "id", type: "uuid", isPrimary: true, generationStrategy: "uuid", isGenerated: true },
        { name: "signup_wallet", type: "varchar", length: "56" },
        { name: "referrer_wallet", type: "varchar", length: "56" },
        { name: "referral_code", type: "varchar", length: "64" },
        { name: "created_at", type: "timestamp with time zone", default: "now()" },
      ],
    }), true);
    await queryRunner.createIndex("waitlist_entries", new TableIndex({
      name: "uq_waitlist_referral_code",
      columnNames: ["referral_code"],
      isUnique: true,
    }));
    await queryRunner.createIndex("waitlist_referral_credits", new TableIndex({
      name: "uq_waitlist_referral_credit_signup",
      columnNames: ["signup_wallet"],
      isUnique: true,
    }));
    await queryRunner.createIndex("waitlist_referral_credits", new TableIndex({
      name: "idx_waitlist_referral_credit_referrer",
      columnNames: ["referrer_wallet"],
    }));
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("waitlist_referral_credits", true);
    await queryRunner.dropIndex("waitlist_entries", "uq_waitlist_referral_code");
    await queryRunner.dropColumn("waitlist_entries", "referred_by_code");
  }
}
