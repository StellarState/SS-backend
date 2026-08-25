import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMarketplaceIndexes1711000000000
  implements MigrationInterface
{
  name = "AddMarketplaceIndexes1711000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX "IDX_INVOICES_STATUS_CREATED"
      ON "invoices" ("status", "created_at" DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_INVOICES_STATUS_AMOUNT"
      ON "invoices" ("status", "amount" DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_INVESTMENTS_INVESTOR_STATUS"
      ON "investments" ("investor_id", "status");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_INVESTMENTS_INVESTOR_STATUS"`);
    await queryRunner.query(`DROP INDEX "IDX_INVOICES_STATUS_AMOUNT"`);
    await queryRunner.query(`DROP INDEX "IDX_INVOICES_STATUS_CREATED"`);
  }
}
