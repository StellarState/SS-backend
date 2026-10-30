import "reflect-metadata";
import { randomUUID } from "crypto";
import { DataSource, QueryRunner } from "typeorm";
import { AddUserKycVerifiedFlag1731900000001 } from "../../src/migrations/1731900000001-AddUserKycVerifiedFlag";

describe("KYC verification flag migration on PostgreSQL", () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;
  const schema = `kyc_migration_${randomUUID().replace(/-/g, "")}`;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: "postgres",
      url: process.env.DATABASE_URL,
      schema,
      entities: [],
      synchronize: false,
    });
    await dataSource.initialize();
    queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.createSchema(schema, true);
    await queryRunner.query(`SET search_path TO "${schema}"`);
    await queryRunner.query(`
      CREATE TABLE users (
        id integer PRIMARY KEY,
        "kycStatus" text NOT NULL,
        is_kyc_verified boolean NOT NULL DEFAULT false
      )
    `);
    await queryRunner.query(`
      INSERT INTO users (id, "kycStatus") VALUES (1, 'approved'), (2, 'pending')
    `);
  });

  afterAll(async () => {
    if (queryRunner) {
      await queryRunner.dropSchema(schema, true, true);
      await queryRunner.release();
    }
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it("handles an existing column, reruns, rollback, and a missing column without losing users", async () => {
    const migration = new AddUserKycVerifiedFlag1731900000001();
    const expected = [
      { id: 1, is_kyc_verified: true },
      { id: 2, is_kyc_verified: false },
    ];
    const readFlags = () => queryRunner.query("SELECT id, is_kyc_verified FROM users ORDER BY id");

    await migration.up(queryRunner);
    await migration.up(queryRunner);
    expect(await readFlags()).toEqual(expected);

    await migration.down(queryRunner);
    await migration.down(queryRunner);
    expect(await queryRunner.hasColumn("users", "is_kyc_verified")).toBe(false);

    await migration.up(queryRunner);
    expect(await readFlags()).toEqual(expected);
  });
});
