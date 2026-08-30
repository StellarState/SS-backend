import { MigrationInterface, QueryRunner } from "typeorm";
import { logger } from "../observability/logger";
import { AppError } from "../utils/http-error";

export class InitialSchema1731513600000 implements MigrationInterface {
  name = "InitialSchema1731513600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    try {
      // 1. Create Enum Types safely
      await queryRunner.query(`
        DO $$ BEGIN
          CREATE TYPE "public"."users_usertype_enum" AS ENUM('seller', 'investor', 'both');
        EXCEPTION WHEN duplicate_object THEN null; END $$;

        DO $$ BEGIN
          CREATE TYPE "public"."users_kycstatus_enum" AS ENUM('pending', 'in_review', 'approved', 'rejected');
        EXCEPTION WHEN duplicate_object THEN null; END $$;

        DO $$ BEGIN
          CREATE TYPE "public"."invoices_invoicestatus_enum" AS ENUM('draft', 'pending', 'published', 'funded', 'settled', 'cancelled', 'rejected');
        EXCEPTION WHEN duplicate_object THEN null; END $$;

        DO $$ BEGIN
          CREATE TYPE "public"."investments_investmentstatus_enum" AS ENUM('pending', 'confirmed', 'settled', 'cancelled');
        EXCEPTION WHEN duplicate_object THEN null; END $$;

        DO $$ BEGIN
          CREATE TYPE "public"."transactions_transactiontype_enum" AS ENUM('investment', 'payment', 'withdrawal', 'refund');
        EXCEPTION WHEN duplicate_object THEN null; END $$;

        DO $$ BEGIN
          CREATE TYPE "public"."transactions_transactionstatus_enum" AS ENUM('pending', 'completed', 'failed');
        EXCEPTION WHEN duplicate_object THEN null; END $$;

        DO $$ BEGIN
          CREATE TYPE "public"."kyc_verifications_verificationtype_enum" AS ENUM('identity', 'address', 'business');
        EXCEPTION WHEN duplicate_object THEN null; END $$;

        DO $$ BEGIN
          CREATE TYPE "public"."notifications_notificationtype_enum" AS ENUM('invoice', 'investment', 'payment', 'kyc', 'system');
        EXCEPTION WHEN duplicate_object THEN null; END $$;
      `);

      // 2. Create Users Table & Indexes
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "users" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "stellarAddress" character varying(56) NOT NULL,
          "email" character varying(255),
          "userType" "public"."users_usertype_enum" NOT NULL DEFAULT 'investor',
          "kycStatus" "public"."users_kycstatus_enum" NOT NULL DEFAULT 'pending',
          "is_kyc_verified" boolean NOT NULL DEFAULT false,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          "deleted_at" TIMESTAMP,
          CONSTRAINT "UQ_users_stellarAddress" UNIQUE ("stellarAddress"),
          CONSTRAINT "PK_users" PRIMARY KEY ("id")
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_stellar_address" ON "users" ("stellarAddress");
        CREATE INDEX IF NOT EXISTS "idx_users_user_type" ON "users" ("userType");
        CREATE INDEX IF NOT EXISTS "idx_users_kyc_status" ON "users" ("kycStatus");
        CREATE INDEX IF NOT EXISTS "idx_users_email" ON "users" ("email");
      `);

      // 3. Create Invoices Table & Optimized Indexes
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "invoices" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "seller_id" uuid NOT NULL,
          "invoice_number" character varying(64) NOT NULL,
          "customer_name" character varying(255) NOT NULL,
          "amount" decimal(18,4) NOT NULL DEFAULT 0,
          "discount_rate" decimal(5,2) NOT NULL DEFAULT 0,
          "net_amount" decimal(18,4) NOT NULL DEFAULT 0,
          "due_date" date NOT NULL,
          "ipfs_hash" character varying(128),
          "risk_score" decimal(5,2),
          "status" "public"."invoices_invoicestatus_enum" NOT NULL DEFAULT 'draft',
          "smart_contract_id" character varying(64),
          "rejection_reason" text,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          "deleted_at" TIMESTAMP,
          CONSTRAINT "UQ_invoices_invoice_number" UNIQUE ("invoice_number"),
          CONSTRAINT "PK_invoices" PRIMARY KEY ("id"),
          CONSTRAINT "FK_invoices_seller" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS "idx_invoices_seller_id" ON "invoices" ("seller_id");
        CREATE UNIQUE INDEX IF NOT EXISTS "idx_invoices_invoice_number" ON "invoices" ("invoice_number");
        CREATE INDEX IF NOT EXISTS "idx_invoices_customer_name" ON "invoices" ("customer_name");
        CREATE INDEX IF NOT EXISTS "idx_invoices_due_date" ON "invoices" ("due_date");
        CREATE INDEX IF NOT EXISTS "idx_invoices_status" ON "invoices" ("status");
        CREATE INDEX IF NOT EXISTS "idx_invoices_seller_status_created" ON "invoices" ("seller_id", "status", "created_at");
        CREATE INDEX IF NOT EXISTS "idx_invoices_status_due_date" ON "invoices" ("status", "due_date");
        CREATE INDEX IF NOT EXISTS "idx_invoices_status_created_at" ON "invoices" ("status", "created_at");
        CREATE INDEX IF NOT EXISTS "idx_invoices_status_amount" ON "invoices" ("status", "amount");
        CREATE INDEX IF NOT EXISTS "idx_invoices_ipfs_hash" ON "invoices" ("ipfs_hash");
        CREATE INDEX IF NOT EXISTS "idx_invoices_smart_contract_id" ON "invoices" ("smart_contract_id");
      `);

      // 4. Create Investments Table & Optimized Indexes
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "investments" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "invoice_id" uuid NOT NULL,
          "investor_id" uuid NOT NULL,
          "investment_amount" decimal(18,4) NOT NULL,
          "expected_return" decimal(18,4) NOT NULL,
          "actual_return" decimal(18,4),
          "status" "public"."investments_investmentstatus_enum" NOT NULL DEFAULT 'pending',
          "transaction_hash" character varying(64),
          "stellar_operation_index" integer,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          "deleted_at" TIMESTAMP,
          CONSTRAINT "PK_investments" PRIMARY KEY ("id"),
          CONSTRAINT "FK_investments_invoice" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE,
          CONSTRAINT "FK_investments_investor" FOREIGN KEY ("investor_id") REFERENCES "users"("id") ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS "idx_investments_invoice_id" ON "investments" ("invoice_id");
        CREATE INDEX IF NOT EXISTS "idx_investments_investor_id" ON "investments" ("investor_id");
        CREATE INDEX IF NOT EXISTS "idx_investments_status" ON "investments" ("status");
        CREATE INDEX IF NOT EXISTS "idx_investments_investor_status" ON "investments" ("investor_id", "status");
        CREATE INDEX IF NOT EXISTS "idx_investments_invoice_status" ON "investments" ("invoice_id", "status");
        CREATE INDEX IF NOT EXISTS "idx_investments_transaction_hash" ON "investments" ("transaction_hash");
      `);

      // 5. Create Transactions Table & Optimized Indexes
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "transactions" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "user_id" uuid NOT NULL,
          "investment_id" uuid,
          "invoice_id" uuid,
          "type" "public"."transactions_transactiontype_enum" NOT NULL,
          "amount" decimal(18,4) NOT NULL,
          "stellar_tx_hash" character varying(64),
          "stellar_operation_index" integer,
          "status" "public"."transactions_transactionstatus_enum" NOT NULL DEFAULT 'pending',
          "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "PK_transactions" PRIMARY KEY ("id"),
          CONSTRAINT "FK_transactions_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
          CONSTRAINT "FK_transactions_investment" FOREIGN KEY ("investment_id") REFERENCES "investments"("id") ON DELETE SET NULL,
          CONSTRAINT "FK_transactions_invoice" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS "idx_transactions_user_id" ON "transactions" ("user_id");
        CREATE INDEX IF NOT EXISTS "idx_transactions_investment_id" ON "transactions" ("investment_id");
        CREATE INDEX IF NOT EXISTS "idx_transactions_invoice_id" ON "transactions" ("invoice_id");
        CREATE INDEX IF NOT EXISTS "idx_transactions_type" ON "transactions" ("type");
        CREATE INDEX IF NOT EXISTS "idx_transactions_status" ON "transactions" ("status");
        CREATE INDEX IF NOT EXISTS "idx_transactions_user_type_status" ON "transactions" ("user_id", "type", "status");
        CREATE INDEX IF NOT EXISTS "idx_transactions_stellar_tx_hash" ON "transactions" ("stellar_tx_hash");
      `);

      // 6. Create KYC Verifications Table & Indexes
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "kyc_verifications" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "user_id" uuid NOT NULL,
          "verification_type" "public"."kyc_verifications_verificationtype_enum" NOT NULL,
          "status" "public"."users_kycstatus_enum" NOT NULL DEFAULT 'pending',
          "documents" jsonb,
          "verified_at" TIMESTAMP WITH TIME ZONE,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          "deleted_at" TIMESTAMP,
          CONSTRAINT "PK_kyc_verifications" PRIMARY KEY ("id"),
          CONSTRAINT "FK_kyc_verifications_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS "idx_kyc_verifications_user_id" ON "kyc_verifications" ("user_id");
        CREATE INDEX IF NOT EXISTS "idx_kyc_verifications_type" ON "kyc_verifications" ("verification_type");
        CREATE INDEX IF NOT EXISTS "idx_kyc_verifications_status" ON "kyc_verifications" ("status");
      `);

      // 7. Create Notifications Table & Indexes
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "notifications" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "user_id" uuid NOT NULL,
          "type" "public"."notifications_notificationtype_enum" NOT NULL,
          "title" character varying(255) NOT NULL,
          "message" text NOT NULL,
          "read" boolean NOT NULL DEFAULT false,
          "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          "deleted_at" TIMESTAMP,
          CONSTRAINT "PK_notifications" PRIMARY KEY ("id"),
          CONSTRAINT "FK_notifications_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS "idx_notifications_user_id" ON "notifications" ("user_id");
        CREATE INDEX IF NOT EXISTS "idx_notifications_type" ON "notifications" ("type");
        CREATE INDEX IF NOT EXISTS "idx_notifications_user_read" ON "notifications" ("user_id", "read");
      `);

      logger.info("InitialSchema migration completed successfully", { migration: this.name });
    } catch (error) {
      logger.error("Failed to execute InitialSchema migration", {
        error: error instanceof Error ? error.message : String(error),
        migration: this.name,
      });
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        500,
        `InitialSchema migration failed: ${error instanceof Error ? error.message : String(error)}`,
        "MIGRATION_EXECUTION_FAILED",
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    try {
      await queryRunner.query(`DROP TABLE IF EXISTS "notifications" CASCADE`);
      await queryRunner.query(`DROP TABLE IF EXISTS "kyc_verifications" CASCADE`);
      await queryRunner.query(`DROP TABLE IF EXISTS "transactions" CASCADE`);
      await queryRunner.query(`DROP TABLE IF EXISTS "investments" CASCADE`);
      await queryRunner.query(`DROP TABLE IF EXISTS "invoices" CASCADE`);
      await queryRunner.query(`DROP TABLE IF EXISTS "users" CASCADE`);
      await queryRunner.query(`DROP TYPE IF EXISTS "public"."notifications_notificationtype_enum" CASCADE`);
      await queryRunner.query(`DROP TYPE IF EXISTS "public"."kyc_verifications_verificationtype_enum" CASCADE`);
      await queryRunner.query(`DROP TYPE IF EXISTS "public"."transactions_transactionstatus_enum" CASCADE`);
      await queryRunner.query(`DROP TYPE IF EXISTS "public"."transactions_transactiontype_enum" CASCADE`);
      await queryRunner.query(`DROP TYPE IF EXISTS "public"."investments_investmentstatus_enum" CASCADE`);
      await queryRunner.query(`DROP TYPE IF EXISTS "public"."invoices_invoicestatus_enum" CASCADE`);
      await queryRunner.query(`DROP TYPE IF EXISTS "public"."users_kycstatus_enum" CASCADE`);
      await queryRunner.query(`DROP TYPE IF EXISTS "public"."users_usertype_enum" CASCADE`);

      logger.info("InitialSchema rollback completed successfully", { migration: this.name });
    } catch (error) {
      logger.error("Failed to rollback InitialSchema migration", {
        error: error instanceof Error ? error.message : String(error),
        migration: this.name,
      });
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        500,
        `InitialSchema rollback failed: ${error instanceof Error ? error.message : String(error)}`,
        "MIGRATION_ROLLBACK_FAILED",
      );
    }
  }
}
