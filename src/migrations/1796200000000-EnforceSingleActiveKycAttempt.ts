import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Issue #739 — at most one active KYC attempt may exist per user/wallet and
 * verification type. Submission and resubmission are serialized in the
 * service; this index is the durable backstop across API replicas.
 *
 * Existing duplicates are retired (never deleted) before the indexes are
 * built: the newest attempt by created_at/id stays active and later ones
 * become rejected with an explicit machine-readable reason.
 */
export class EnforceSingleActiveKycAttempt1796200000000 implements MigrationInterface {
  name = "EnforceSingleActiveKycAttempt1796200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "kyc_verifications" AS v
      SET "status" = 'rejected',
          "verified_at" = now(),
          "documents" = COALESCE(v."documents", '{}'::jsonb) ||
            '{"rejectionReason":"Superseded duplicate active KYC attempt (issue #739)"}'::jsonb
      FROM (
        SELECT "id",
               row_number() OVER (
                 PARTITION BY "user_id", "verification_type"
                 ORDER BY "created_at" DESC, "id" DESC
               ) AS rn
        FROM "kyc_verifications"
        WHERE "status" IN ('pending', 'in_review', 'approved')
      ) AS ranked
      WHERE v."id" = ranked."id" AND ranked.rn > 1
    `);

    await queryRunner.query(`
      UPDATE "kyc_verifications" AS v
      SET "status" = 'rejected',
          "verified_at" = now(),
          "documents" = COALESCE(v."documents", '{}'::jsonb) ||
            '{"rejectionReason":"Superseded duplicate active KYC attempt (issue #739)"}'::jsonb
      FROM (
        SELECT "id",
               row_number() OVER (
                 PARTITION BY "wallet", "verification_type"
                 ORDER BY "created_at" DESC, "id" DESC
               ) AS rn
        FROM "kyc_verifications"
        WHERE "wallet" IS NOT NULL
          AND "status" IN ('pending', 'in_review', 'approved')
      ) AS ranked
      WHERE v."id" = ranked."id" AND ranked.rn > 1
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_kyc_verifications_active_user_type"
      ON "kyc_verifications" ("user_id", "verification_type")
      WHERE "status" IN ('pending', 'in_review', 'approved')
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_kyc_verifications_active_wallet_type"
      ON "kyc_verifications" ("wallet", "verification_type")
      WHERE "wallet" IS NOT NULL AND "status" IN ('pending', 'in_review', 'approved')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Retired duplicate rows are intentionally left rejected.
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_kyc_verifications_active_wallet_type"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_kyc_verifications_active_user_type"`);
  }
}
