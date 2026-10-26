import { AddInvestorOnboardingAlertAndYieldData1732200000000 } from "../../src/migrations/1732200000000-AddInvestorOnboardingAlertAndYieldData";
import { AddSorobanIndexerCheckpoint1732800000000 } from "../../src/migrations/1732800000000-AddSorobanIndexerCheckpoint";
import { jest } from "@jest/globals";

describe("Soroban Indexer Checkpoint Migrations Safety", () => {
  let mockQueryRunner: { query: jest.Mock<(sql: string) => Promise<unknown[]>> };

  beforeEach(() => {
    mockQueryRunner = {
      query: jest.fn(async (_sql: string) => []),
    };
  });

  describe("AddInvestorOnboardingAlertAndYieldData1732200000000", () => {
    it("should not duplicate soroban_event_logs or soroban_indexer_checkpoints in up migration", async () => {
      const migration = new AddInvestorOnboardingAlertAndYieldData1732200000000();
      await migration.up(mockQueryRunner as any);

      const executedQueries: string[] = mockQueryRunner.query.mock.calls.map((call: unknown[]) =>
        String(call[0])
      );

      // Verify that onboarding_bonuses, alert_preferences, yield_adjustments are created
      expect(executedQueries.some((sql: string) => sql.includes("onboarding_bonuses"))).toBe(true);
      expect(executedQueries.some((sql: string) => sql.includes("alert_preferences"))).toBe(true);
      expect(executedQueries.some((sql: string) => sql.includes("yield_adjustments"))).toBe(true);

      // Ensure no conflicting table or column creation
      expect(executedQueries.some((sql: string) => sql.includes("soroban_indexer_checkpoints"))).toBe(
        false
      );
      expect(
        executedQueries.some(
          (sql: string) => sql.includes("soroban_event_logs") && sql.includes("ADD COLUMN")
        )
      ).toBe(false);
    });

    it("should drop only its own tables on down migration", async () => {
      const migration = new AddInvestorOnboardingAlertAndYieldData1732200000000();
      await migration.down(mockQueryRunner as any);

      const executedQueries: string[] = mockQueryRunner.query.mock.calls.map((call: unknown[]) =>
        String(call[0])
      );

      expect(executedQueries.some((sql: string) => sql.includes("soroban_indexer_checkpoints"))).toBe(
        false
      );
      expect(executedQueries.some((sql: string) => sql.includes("soroban_event_logs"))).toBe(false);
    });
  });

  describe("AddSorobanIndexerCheckpoint1732800000000", () => {
    it("should be idempotent and guarded with IF NOT EXISTS in up migration", async () => {
      const migration = new AddSorobanIndexerCheckpoint1732800000000();
      await migration.up(mockQueryRunner as any);

      const executedQueries: string[] = mockQueryRunner.query.mock.calls.map((call: unknown[]) =>
        String(call[0])
      );

      expect(
        executedQueries.some(
          (sql: string) =>
            sql.includes("ALTER TABLE \"soroban_event_logs\"") &&
            sql.includes("ADD COLUMN IF NOT EXISTS \"event_id\"")
        )
      ).toBe(true);

      expect(
        executedQueries.some((sql: string) =>
          sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS \"uq_soroban_event_logs_contract_event\"")
        )
      ).toBe(true);

      expect(
        executedQueries.some((sql: string) =>
          sql.includes("CREATE TABLE IF NOT EXISTS \"soroban_indexer_checkpoints\"")
        )
      ).toBe(true);
    });

    it("should use IF EXISTS in down migration", async () => {
      const migration = new AddSorobanIndexerCheckpoint1732800000000();
      await migration.down(mockQueryRunner as any);

      const executedQueries: string[] = mockQueryRunner.query.mock.calls.map((call: unknown[]) =>
        String(call[0])
      );

      expect(
        executedQueries.some((sql: string) =>
          sql.includes("DROP TABLE IF EXISTS \"soroban_indexer_checkpoints\"")
        )
      ).toBe(true);

      expect(
        executedQueries.some(
          (sql: string) =>
            sql.includes("DROP INDEX IF EXISTS") &&
            sql.includes("uq_soroban_event_logs_contract_event")
        )
      ).toBe(true);

      expect(
        executedQueries.some((sql: string) =>
          sql.includes("ALTER TABLE \"soroban_event_logs\" DROP COLUMN IF EXISTS \"event_id\"")
        )
      ).toBe(true);
    });
  });
});
