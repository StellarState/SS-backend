import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

export class AddDocumentExportCleanupColumns1796300000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      "document_export_jobs",
      new TableColumn({
        name: "deleted_at",
        type: "timestamptz",
        isNullable: true,
      }),
    );
    await queryRunner.addColumn(
      "document_export_jobs",
      new TableColumn({
        name: "cleanup_error",
        type: "text",
        isNullable: true,
      }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn("document_export_jobs", "cleanup_error");
    await queryRunner.dropColumn("document_export_jobs", "deleted_at");
  }
}
