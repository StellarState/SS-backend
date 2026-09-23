import { AddMarketplaceIndexes1711100000000 } from "../../src/migrations/1711100000000-AddMarketplaceIndexes";
import { AppError } from "../../src/utils/http-error";

describe("AddMarketplaceIndexes Migration - Issue #144", () => {
  let migration: AddMarketplaceIndexes1711100000000;
  let mockQueryRunner: any;

  beforeEach(() => {
    migration = new AddMarketplaceIndexes1711100000000();
    mockQueryRunner = {
      query: jest.fn().mockResolvedValue(undefined),
    };
  });

  it("should execute up migration successfully", async () => {
    await migration.up(mockQueryRunner);
    expect(mockQueryRunner.query).toHaveBeenCalledTimes(3);
  });

  it("should create IDX_INVOICES_STATUS_CREATED_AT_DESC index", async () => {
    await migration.up(mockQueryRunner);
    const calls = mockQueryRunner.query.mock.calls.map((c) => c[0]);
    expect(calls.some((sql) => sql.includes("IDX_INVOICES_STATUS_CREATED_AT_DESC"))).toBe(true);
    expect(calls.some((sql) => sql.includes("created_at\" DESC"))).toBe(true);
  });

  it("should create IDX_INVOICES_STATUS_AMOUNT_DESC index", async () => {
    await migration.up(mockQueryRunner);
    const calls = mockQueryRunner.query.mock.calls.map((c) => c[0]);
    expect(calls.some((sql) => sql.includes("IDX_INVOICES_STATUS_AMOUNT_DESC"))).toBe(true);
    expect(calls.some((sql) => sql.includes("amount\" DESC"))).toBe(true);
  });

  it("should create IDX_INVESTMENTS_INVESTOR_ID_STATUS index", async () => {
    await migration.up(mockQueryRunner);
    const calls = mockQueryRunner.query.mock.calls.map((c) => c[0]);
    expect(calls.some((sql) => sql.includes("IDX_INVESTMENTS_INVESTOR_ID_STATUS"))).toBe(true);
    expect(calls.some((sql) => sql.includes("investor_id") && sql.includes("status"))).toBe(true);
  });

  it("should throw AppError on up migration failure", async () => {
    mockQueryRunner.query.mockRejectedValue(new Error("Database connection lost"));
    await expect(migration.up(mockQueryRunner)).rejects.toThrow(AppError);
  });

  it("should execute down migration successfully", async () => {
    await migration.down(mockQueryRunner);
    expect(mockQueryRunner.query).toHaveBeenCalledTimes(3);
  });

  it("should drop indexes in reverse order on down migration", async () => {
    await migration.down(mockQueryRunner);
    const calls = mockQueryRunner.query.mock.calls.map((c) => c[0]);
    expect(calls[0]).toContain("IDX_INVESTMENTS_INVESTOR_ID_STATUS");
    expect(calls[1]).toContain("IDX_INVOICES_STATUS_AMOUNT_DESC");
    expect(calls[2]).toContain("IDX_INVOICES_STATUS_CREATED_AT_DESC");
  });

  it("should throw AppError on down migration failure", async () => {
    mockQueryRunner.query.mockRejectedValue(new Error("Index drop constraint failed"));
    await expect(migration.down(mockQueryRunner)).rejects.toThrow(AppError);
  });
});