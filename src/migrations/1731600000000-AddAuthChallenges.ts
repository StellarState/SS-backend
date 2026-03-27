import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAuthChallenges1731600000000 implements MigrationInterface {
  name = "AddAuthChallenges1731600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "auth_challenges" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "stellar_address" character varying(56) NOT NULL,
        "nonce_hash" character varying(64) NOT NULL,
        "message" text NOT NULL,
        "network" character varying(32) NOT NULL,
        "issued_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "consumed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_auth_challenges" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_auth_challenges_address_nonce"
      ON "auth_challenges" ("stellar_address", "nonce_hash");
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_auth_challenges_stellar_address"
      ON "auth_challenges" ("stellar_address");
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_auth_challenges_expires_at"
      ON "auth_challenges" ("expires_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_auth_challenges_expires_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_auth_challenges_stellar_address"`);
    await queryRunner.query(`DROP INDEX "public"."idx_auth_challenges_address_nonce"`);
    await queryRunner.query(`DROP TABLE "auth_challenges"`);
  }
}
