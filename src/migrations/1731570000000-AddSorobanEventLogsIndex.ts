import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSorobanEventLogsIndex1731570000000 implements MigrationInterface {
  name = "AddSorobanEventLogsIndex1731570000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX "IDX_SOROBAN_EVENTS_CONTRACT_LEDGER"
      ON "soroban_event_logs" ("contract_id", "ledger_sequence" DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX "public"."IDX_SOROBAN_EVENTS_CONTRACT_LEDGER";
    `);
  }
}
