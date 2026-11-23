import { MigrationInterface, QueryRunner } from "typeorm";

export class AddNotificationDeadLetters1732000000000 implements MigrationInterface {
  name = "AddNotificationDeadLetters1732000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "notification_dead_letters" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "type" character varying(32) NOT NULL,
        "title" character varying(255) NOT NULL,
        "message" text NOT NULL,
        "status" character varying(32) NOT NULL DEFAULT 'pending',
        "attempt_count" integer NOT NULL DEFAULT 0,
        "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "last_error" character varying(500),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_notification_dead_letters" PRIMARY KEY ("id"),
        CONSTRAINT "FK_notification_dead_letters_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      );
      CREATE INDEX "idx_notification_dead_letters_user_id" ON "notification_dead_letters" ("user_id");
      CREATE INDEX "idx_notification_dead_letters_status" ON "notification_dead_letters" ("status");
      CREATE INDEX "idx_notification_dead_letters_next_attempt" ON "notification_dead_letters" ("next_attempt_at");
      CREATE TABLE "notification_dead_letter_audits" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "dead_letter_id" uuid NOT NULL,
        "action" character varying(32) NOT NULL,
        "actor_id" character varying(255),
        "success" boolean NOT NULL,
        "error_code" character varying(64),
        "error_message" character varying(500),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_notification_dead_letter_audits" PRIMARY KEY ("id"),
        CONSTRAINT "FK_notification_dead_letter_audits_dead_letter" FOREIGN KEY ("dead_letter_id") REFERENCES "notification_dead_letters"("id") ON DELETE CASCADE
      );
      CREATE INDEX "idx_notification_dead_letter_audits_dead_letter_id" ON "notification_dead_letter_audits" ("dead_letter_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "notification_dead_letter_audits"`);
    await queryRunner.query(`DROP TABLE "notification_dead_letters"`);
  }
}
