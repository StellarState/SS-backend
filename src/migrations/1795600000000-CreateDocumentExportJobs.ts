import { MigrationInterface, QueryRunner, Table, TableIndex } from "typeorm";

export class CreateDocumentExportJobs1795600000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(new Table({
      name: "document_export_jobs",
      columns: [
        { name: "id", type: "varchar", length: "160", isPrimary: true },
        { name: "invoice_id", type: "uuid" },
        { name: "requester_id", type: "uuid" },
        { name: "status", type: "varchar", length: "24" },
        { name: "progress", type: "integer", default: 0 },
        { name: "total_documents", type: "integer", default: 0 },
        { name: "processed_documents", type: "integer", default: 0 },
        { name: "zip_path", type: "varchar", length: "1024", isNullable: true },
        { name: "download_token", type: "varchar", length: "512", isNullable: true },
        { name: "download_token_expires_at", type: "timestamptz", isNullable: true },
        { name: "error", type: "text", isNullable: true },
        { name: "lease_owner", type: "varchar", length: "64", isNullable: true },
        { name: "lease_expires_at", type: "timestamptz", isNullable: true },
        { name: "expires_at", type: "timestamptz", isNullable: true },
        { name: "created_at", type: "timestamptz", default: "now()" },
        { name: "completed_at", type: "timestamptz", isNullable: true },
        { name: "cancelled_at", type: "timestamptz", isNullable: true },
        { name: "updated_at", type: "timestamptz", default: "now()" },
      ],
    }), true);
    await queryRunner.createIndex(
      "document_export_jobs",
      new TableIndex({
        name: "idx_document_export_jobs_status_lease",
        columnNames: ["status", "lease_expires_at"],
      }),
    );
    await queryRunner.createIndex(
      "document_export_jobs",
      new TableIndex({
        name: "idx_document_export_jobs_expiry",
        columnNames: ["status", "expires_at"],
      }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("document_export_jobs", true);
  }
}
