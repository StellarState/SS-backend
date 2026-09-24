import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAcknowledgementsAndExtensionRequests1732000000000
  implements MigrationInterface
{
  name = "AddAcknowledgementsAndExtensionRequests1732000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "investor_acknowledgements" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "terms_version" varchar(32) NOT NULL,
        "acknowledged_at" timestamptz NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_acknowledgements_user_id"
      ON "investor_acknowledgements" ("user_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_acknowledgements_user_terms"
      ON "investor_acknowledgements" ("user_id", "terms_version");
    `);

    await queryRunner.query(`
      CREATE TYPE "extension_request_status_enum" AS ENUM ('pending', 'approved', 'rejected');
    `).catch(() => {
      // Enum type may already exist if this migration runs more than once in dev.
    });

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "extension_requests" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "invoice_id" uuid NOT NULL,
        "requested_by" uuid NOT NULL,
        "current_deadline" date NOT NULL,
        "proposed_deadline" date NOT NULL,
        "status" "extension_request_status_enum" NOT NULL DEFAULT 'pending',
        "reviewed_by" uuid,
        "reviewed_at" timestamptz,
        "rejection_reason" varchar(255),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_extension_requests_invoice_id"
      ON "extension_requests" ("invoice_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_extension_requests_status"
      ON "extension_requests" ("status");
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_extension_requests_invoice'
        ) THEN
          ALTER TABLE "extension_requests"
          ADD CONSTRAINT "FK_extension_requests_invoice"
          FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id")
          ON DELETE CASCADE;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "extension_requests";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "extension_request_status_enum";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "investor_acknowledgements";`);
  }
}
