import "reflect-metadata";
import { DataSource, QueryRunner } from "typeorm";
import { AddSorobanEscrowFieldsToInvoice1731900000000 } from "../../src/migrations/1731900000000-AddSorobanEscrowFieldsToInvoice";

describe("AddSorobanEscrowFieldsToInvoice migration", () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [],
      synchronize: false,
    });
    await dataSource.initialize();
    queryRunner = dataSource.createQueryRunner();
    await queryRunner.query(`CREATE TABLE "invoices" ("id" varchar PRIMARY KEY)`);
  });

  afterEach(async () => {
    await queryRunner.release();
    await dataSource.destroy();
  });

  it("adds all nullable escrow tracking columns with the requested types", async () => {
    const migration = new AddSorobanEscrowFieldsToInvoice1731900000000();

    await migration.up(queryRunner);

    const table = await queryRunner.getTable("invoices");
    expect(table).toBeDefined();
    expect(table?.findColumnByName("soroban_contract_id")).toMatchObject({
      type: "varchar",
      length: "56",
      isNullable: true,
    });
    expect(table?.findColumnByName("onchain_status")).toMatchObject({
      type: "varchar",
      enum: ["UNINITIALIZED", "ACTIVE", "SETTLED", "REFUNDED", "PAUSED"],
      isNullable: true,
    });
    expect(table?.findColumnByName("creation_tx_hash")).toMatchObject({
      type: "varchar",
      length: "64",
      isNullable: true,
    });
    expect(table?.findColumnByName("last_synced_ledger")).toMatchObject({
      type: "bigint",
      isNullable: true,
    });
  });

  it("removes all escrow tracking columns when reverted", async () => {
    const migration = new AddSorobanEscrowFieldsToInvoice1731900000000();
    await migration.up(queryRunner);

    await migration.down(queryRunner);

    const table = await queryRunner.getTable("invoices");
    expect(table?.findColumnByName("soroban_contract_id")).toBeUndefined();
    expect(table?.findColumnByName("onchain_status")).toBeUndefined();
    expect(table?.findColumnByName("creation_tx_hash")).toBeUndefined();
    expect(table?.findColumnByName("last_synced_ledger")).toBeUndefined();
  });
});
