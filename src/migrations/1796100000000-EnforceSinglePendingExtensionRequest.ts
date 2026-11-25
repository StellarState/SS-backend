import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Issue #734 — at most one pending funding extension request per invoice,
 * enforced by the database so concurrent submissions (double clicks,
 * retries, several API replicas) cannot create two.
 *
 * Existing duplicates must be resolved before the index can be built. For
 * each invoice with more than one pending request, the earliest one stays
 * pending and the later ones are marked rejected with a review note, so no
 * row is deleted and the audit trail keeps every proposal.
 */
export class EnforceSinglePendingExtensionRequest1796100000000 implements MigrationInterface {
  name = "EnforceSinglePendingExtensionRequest1796100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "invoice_extension_requests" AS r
      SET "status" = 'rejected',
          "reviewed_by" = 'system:migration-1796100000000',
          "reviewed_at" = now(),
          "review_note" = 'Superseded duplicate pending request (issue #734)',
          "updated_at" = now()
      FROM (
        SELECT "id",
               row_number() OVER (
                 PARTITION BY "invoice_id" ORDER BY "created_at" ASC, "id" ASC
               ) AS rn
        FROM "invoice_extension_requests"
        WHERE "status" = 'pending'
      ) AS ranked
      WHERE r."id" = ranked."id" AND ranked.rn > 1
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_extension_requests_one_pending_per_invoice"
      ON "invoice_extension_requests" ("invoice_id")
      WHERE "status" = 'pending'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rows rejected by up() stay rejected: re-opening them would recreate
    // the duplicates the index exists to prevent.
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_extension_requests_one_pending_per_invoice"`);
  }
}
