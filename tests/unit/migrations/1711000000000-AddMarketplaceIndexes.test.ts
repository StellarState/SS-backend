import { QueryRunner } from "typeorm";
import { AddMarketplaceIndexes1711000000000 } from "../../../src/migrations/1711000000000-AddMarketplaceIndexes";

jest.mock("typeorm", () => ({
  ...jest.requireActual("typeorm"),
  DataSource: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    createQueryRunner: jest.fn().mockReturnValue({
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue(undefined),
    }),
  })),
}));

describe("1711000000000-AddMarketplaceIndexes", () => {
  let migration: AddMarketplaceIndexes1711000000000;

  beforeEach(() => {
    migration = new AddMarketplaceIndexes1711000000000();
  });

  describe("migration metadata", () => {
    it("should have the correct migration name", () => {
      expect(migration.name).toBe("AddMarketplaceIndexes1711000000000");
    });
  });

  describe("up", () => {
    it("should be a function", () => {
      expect(typeof migration.up).toBe("function");
    });
  });

  describe("down", () => {
    it("should be a function", () => {
      expect(typeof migration.down).toBe("function");
    });
  });
});
