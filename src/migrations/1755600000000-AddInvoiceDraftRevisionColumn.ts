import { MigrationInterface, QueryRunner } from "typeorm";

export class AddInvoiceDraftRevisionColumn1755600000000 implements MigrationInterface {
  name = "AddInvoiceDraftRevisionColumn1755600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "public"."invoice_drafts"
      ADD COLUMN IF NOT EXISTS "revision" integer NOT NULL DEFAULT 1;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "public"."invoice_drafts"
      DROP COLUMN IF EXISTS "revision";
    `);
  }
}
