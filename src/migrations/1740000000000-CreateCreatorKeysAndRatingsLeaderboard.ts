import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates the creator_keys table for ratings-based leaderboard feature.
 * Tracks aggregate rating data (sum, count, average) per creator key.
 */
export class CreateCreatorKeysAndRatingsLeaderboard1740000000000 implements MigrationInterface {
  name = "CreateCreatorKeysAndRatingsLeaderboard1740000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "creator_keys" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "key_address" varchar(128),
        "creator_wallet" varchar(56) NOT NULL,
        "name" varchar(255),
        "description" text,
        "image_url" varchar(512),
        "rating_count" integer NOT NULL DEFAULT 0,
        "rating_sum" decimal(18,4) NOT NULL DEFAULT 0,
        "average_rating" decimal(5,4) NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_creator_keys_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      ALTER TABLE "creator_keys"
      ADD COLUMN IF NOT EXISTS "key_address" varchar(128),
      ADD COLUMN IF NOT EXISTS "name" varchar(255),
      ADD COLUMN IF NOT EXISTS "description" text,
      ADD COLUMN IF NOT EXISTS "image_url" varchar(512),
      ADD COLUMN IF NOT EXISTS "rating_count" integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "rating_sum" decimal(18,4) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "average_rating" decimal(5,4) NOT NULL DEFAULT 0;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'UQ_creator_keys_key_address'
        ) THEN
          ALTER TABLE "creator_keys" ADD CONSTRAINT "UQ_creator_keys_key_address" UNIQUE ("key_address");
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_creator_keys_key_address"
      ON "creator_keys" ("key_address");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_creator_keys_creator_wallet"
      ON "creator_keys" ("creator_wallet");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_creator_keys_average_rating"
      ON "creator_keys" ("average_rating" DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_creator_keys_rating_count"
      ON "creator_keys" ("rating_count");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_creator_keys_rating_count";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_creator_keys_average_rating";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_creator_keys_creator_wallet";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_creator_keys_key_address";`);
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'UQ_creator_keys_key_address'
        ) THEN
          ALTER TABLE "creator_keys" DROP CONSTRAINT "UQ_creator_keys_key_address";
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      ALTER TABLE "creator_keys"
      DROP COLUMN IF EXISTS "average_rating",
      DROP COLUMN IF EXISTS "rating_sum",
      DROP COLUMN IF EXISTS "rating_count",
      DROP COLUMN IF EXISTS "image_url",
      DROP COLUMN IF EXISTS "description",
      DROP COLUMN IF EXISTS "name",
      DROP COLUMN IF EXISTS "key_address";
    `);
  }
}
