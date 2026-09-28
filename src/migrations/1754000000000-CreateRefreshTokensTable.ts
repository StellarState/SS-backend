import { MigrationInterface, QueryRunner } from "typeorm";

/** Hashed, single-use refresh tokens grouped by login session (issue #563). */
export class CreateRefreshTokensTable1754000000000 implements MigrationInterface {
  name = "CreateRefreshTokensTable1754000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "token_hash" character varying(64) NOT NULL,
        "user_id" uuid NOT NULL,
        "stellar_address" character varying(56) NOT NULL,
        "session_id" uuid NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "used_at" TIMESTAMP WITH TIME ZONE,
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "replaced_by_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_refresh_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "FK_refresh_tokens_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_refresh_tokens_token_hash" ON "refresh_tokens" ("token_hash")`
    );
    await queryRunner.query(
      `CREATE INDEX "idx_refresh_tokens_stellar_address" ON "refresh_tokens" ("stellar_address")`
    );
    await queryRunner.query(
      `CREATE INDEX "idx_refresh_tokens_session_id" ON "refresh_tokens" ("session_id")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_refresh_tokens_session_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_refresh_tokens_stellar_address"`);
    await queryRunner.query(`DROP INDEX "public"."idx_refresh_tokens_token_hash"`);
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
  }
}
