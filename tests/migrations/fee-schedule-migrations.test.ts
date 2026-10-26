import { CreateFeeScheduleTables1754000000000 } from "../../src/migrations/1754000000000-CreateFeeScheduleTables";
import { jest } from "@jest/globals";

describe("CreateFeeScheduleTables1754000000000 Migration", () => {
  let mockQueryRunner: { query: jest.Mock<(sql: string) => Promise<unknown[]>> };

  beforeEach(() => {
    mockQueryRunner = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("to_regclass")) {
          return [{ table: null }];
        }
        return [];
      }),
    };
  });

  it("should create fee_schedules without invalid EXCLUDE USING syntax and with partial unique index", async () => {
    const migration = new CreateFeeScheduleTables1754000000000();
    await migration.up(mockQueryRunner as any);

    const executedQueries: string[] = mockQueryRunner.query.mock.calls.map((call: unknown[]) =>
      String(call[0])
    );

    // Verify no broken EXCLUDE syntax
    expect(executedQueries.some((sql: string) => sql.includes("EXCLUDE (USING"))).toBe(false);
    expect(executedQueries.some((sql: string) => sql.includes("gist("))).toBe(false);

    // Verify partial unique index for single active schedule
    expect(
      executedQueries.some(
        (sql: string) =>
          sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS \"only_one_active_schedule\"") &&
          sql.includes("WHERE (\"is_active\" = true)")
      )
    ).toBe(true);

    // Verify table creation
    expect(
      executedQueries.some((sql: string) => sql.includes("CREATE TABLE IF NOT EXISTS \"public\".\"fee_schedules\""))
    ).toBe(true);

    expect(
      executedQueries.some((sql: string) => sql.includes("CREATE TABLE IF NOT EXISTS \"public\".\"fee_schedule_history\""))
    ).toBe(true);

    // Verify idempotent default insertion
    expect(
      executedQueries.some(
        (sql: string) =>
          sql.includes("INSERT INTO \"public\".\"fee_schedules\"") &&
          sql.includes("WHERE NOT EXISTS")
      )
    ).toBe(true);
  });

  it("should drop tables on rollback", async () => {
    const migration = new CreateFeeScheduleTables1754000000000();
    await migration.down(mockQueryRunner as any);

    const executedQueries: string[] = mockQueryRunner.query.mock.calls.map((call: unknown[]) =>
      String(call[0])
    );

    expect(
      executedQueries.some((sql: string) =>
        sql.includes("DROP TABLE IF EXISTS \"public\".\"fee_schedules\"")
      )
    ).toBe(true);

    expect(
      executedQueries.some((sql: string) =>
        sql.includes("DROP TABLE IF EXISTS \"public\".\"fee_schedule_history\"")
      )
    ).toBe(true);
  });
});
