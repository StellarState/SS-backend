import { CreateCreatorKeysTable1732800000000 } from "../../src/migrations/1732800000000-CreateCreatorKeysTable";
import { CreateCreatorKeysAndRatingsLeaderboard1740000000000 } from "../../src/migrations/1740000000000-CreateCreatorKeysAndRatingsLeaderboard";
import { jest } from "@jest/globals";

describe("Creator Keys Migrations Safety", () => {
  let mockQueryRunner: { query: jest.Mock<(sql: string) => Promise<unknown[]>> };

  beforeEach(() => {
    mockQueryRunner = {
      query: jest.fn(async (_sql: string) => []),
    };
  });

  describe("CreateCreatorKeysTable1732800000000", () => {
    it("should create creator_keys table with key_address included and guarded", async () => {
      const migration = new CreateCreatorKeysTable1732800000000();
      await migration.up(mockQueryRunner as any);

      const executedQueries: string[] = mockQueryRunner.query.mock.calls.map((call: unknown[]) =>
        String(call[0])
      );

      expect(executedQueries.some((sql: string) => sql.includes("CREATE TABLE IF NOT EXISTS \"creator_keys\""))).toBe(true);
      expect(executedQueries.some((sql: string) => sql.includes("key_address"))).toBe(true);
      expect(executedQueries.some((sql: string) => sql.includes("idx_creator_keys_contract_address"))).toBe(true);
    });

    it("should drop indexes and table on down migration", async () => {
      const migration = new CreateCreatorKeysTable1732800000000();
      await migration.down(mockQueryRunner as any);

      const executedQueries: string[] = mockQueryRunner.query.mock.calls.map((call: unknown[]) =>
        String(call[0])
      );

      expect(executedQueries.some((sql: string) => sql.includes("DROP TABLE IF EXISTS \"creator_keys\""))).toBe(true);
    });
  });

  describe("CreateCreatorKeysAndRatingsLeaderboard1740000000000", () => {
    it("should alter creator_keys to add key_address and ratings columns if table exists", async () => {
      const migration = new CreateCreatorKeysAndRatingsLeaderboard1740000000000();
      await migration.up(mockQueryRunner as any);

      const executedQueries: string[] = mockQueryRunner.query.mock.calls.map((call: unknown[]) =>
        String(call[0])
      );

      expect(
        executedQueries.some(
          (sql: string) =>
            sql.includes("ALTER TABLE \"creator_keys\"") &&
            sql.includes("ADD COLUMN IF NOT EXISTS \"key_address\"") &&
            sql.includes("ADD COLUMN IF NOT EXISTS \"average_rating\"")
        )
      ).toBe(true);

      expect(
        executedQueries.some(
          (sql: string) =>
            sql.includes("CREATE INDEX IF NOT EXISTS \"idx_creator_keys_key_address\"")
        )
      ).toBe(true);

      expect(
        executedQueries.some(
          (sql: string) =>
            sql.includes("CREATE INDEX IF NOT EXISTS \"idx_creator_keys_average_rating\"")
        )
      ).toBe(true);
    });

    it("should cleanly drop ratings columns and indexes without dropping creator_keys table on down migration", async () => {
      const migration = new CreateCreatorKeysAndRatingsLeaderboard1740000000000();
      await migration.down(mockQueryRunner as any);

      const executedQueries: string[] = mockQueryRunner.query.mock.calls.map((call: unknown[]) =>
        String(call[0])
      );

      expect(
        executedQueries.some((sql: string) => sql.includes("DROP TABLE IF EXISTS \"creator_keys\""))
      ).toBe(false);

      expect(
        executedQueries.some(
          (sql: string) =>
            sql.includes("ALTER TABLE \"creator_keys\"") &&
            sql.includes("DROP COLUMN IF EXISTS \"key_address\"") &&
            sql.includes("DROP COLUMN IF EXISTS \"average_rating\"")
        )
      ).toBe(true);
    });
  });
});
