import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateKycWebhookEvents1795300000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "kyc_webhook_events" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "provider" character varying(100) NOT NULL,
      "event_id" character varying(255) NOT NULL,
      "status" character varying(20) NOT NULL,
      "payload" jsonb NOT NULL,
      "attempt_count" integer NOT NULL DEFAULT 0,
      "error_message" text,
      "failure_kind" character varying(20),
      "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "processing_started_at" TIMESTAMP WITH TIME ZONE,
      "completed_at" TIMESTAMP WITH TIME ZONE,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_kyc_webhook_events" PRIMARY KEY ("id"),
      CONSTRAINT "CHK_kyc_webhook_events_status" CHECK ("status" IN ('received', 'processing', 'succeeded', 'failed')),
      CONSTRAINT "CHK_kyc_webhook_events_failure_kind" CHECK ("failure_kind" IS NULL OR "failure_kind" IN ('permanent', 'retryable'))
    )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_kyc_webhook_events_provider_event" ON "kyc_webhook_events" ("provider", "event_id")`
    );
    await queryRunner.query(
      `CREATE INDEX "idx_kyc_webhook_events_status_processing" ON "kyc_webhook_events" ("status", "processing_started_at")`
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "kyc_webhook_events"`);
  }
}
