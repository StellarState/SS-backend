import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOptimisticLockingVersion1711000000001
  implements MigrationInterface
{
  name = "AddOptimisticLockingVersion1711000000001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "invoices" ADD COLUMN "version" integer NOT NULL DEFAULT 1;
    `);

    await queryRunner.query(`
      ALTER TABLE "investments" ADD COLUMN "version" integer NOT NULL DEFAULT 1;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "investments" DROP COLUMN "version"`);
    await queryRunner.query(`ALTER TABLE "invoices" DROP COLUMN "version"`);
  }
}
