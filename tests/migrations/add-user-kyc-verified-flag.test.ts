import { TableColumn } from "typeorm";
import { AddUserKycVerifiedFlag1731900000001 } from "../../src/migrations/1731900000001-AddUserKycVerifiedFlag";

interface QueryRunnerMock {
  hasColumn: jest.Mock<Promise<boolean>, [string, string]>;
  addColumn: jest.Mock<Promise<void>, [string, TableColumn]>;
  dropColumn: jest.Mock<Promise<void>, [string, string]>;
  query: jest.Mock<Promise<unknown>, [string]>;
}

function createQueryRunnerMock(columnExists: boolean): QueryRunnerMock {
  return {
    hasColumn: jest.fn<Promise<boolean>, [string, string]>().mockResolvedValue(columnExists),
    addColumn: jest.fn<Promise<void>, [string, TableColumn]>(async () => {
      if (columnExists) {
        throw new Error(
          'QueryFailedError: column "is_kyc_verified" of relation "users" already exists'
        );
      }
    }),
    dropColumn: jest.fn<Promise<void>, [string, string]>(async () => {
      if (!columnExists) {
        throw new Error(
          'QueryFailedError: column "is_kyc_verified" of relation "users" does not exist'
        );
      }
    }),
    query: jest.fn<Promise<unknown>, [string]>().mockResolvedValue(undefined),
  };
}

describe("AddUserKycVerifiedFlag1731900000001 - Issue #631", () => {
  let migration: AddUserKycVerifiedFlag1731900000001;

  beforeEach(() => {
    migration = new AddUserKycVerifiedFlag1731900000001();
  });

  it("reports the expected migration name", () => {
    expect(migration.name).toBe("AddUserKycVerifiedFlag1731900000001");
  });

  it("skips addColumn when is_kyc_verified already exists from InitialSchema", async () => {
    const queryRunner = createQueryRunnerMock(true);

    await expect(migration.up(queryRunner as never)).resolves.toBeUndefined();

    expect(queryRunner.hasColumn).toHaveBeenCalledWith("users", "is_kyc_verified");
    expect(queryRunner.addColumn).not.toHaveBeenCalled();
    expect(queryRunner.query).toHaveBeenCalledTimes(1);
    expect(queryRunner.query.mock.calls[0][0]).toContain('SET "is_kyc_verified" = true');
  });

  it("adds is_kyc_verified column and backfills approved users when column does not exist", async () => {
    const queryRunner = createQueryRunnerMock(false);

    await expect(migration.up(queryRunner as never)).resolves.toBeUndefined();

    expect(queryRunner.hasColumn).toHaveBeenCalledWith("users", "is_kyc_verified");
    expect(queryRunner.addColumn).toHaveBeenCalledTimes(1);
    const [tableName, column] = queryRunner.addColumn.mock.calls[0];
    expect(tableName).toBe("users");
    expect(column).toBeInstanceOf(TableColumn);
    expect(column.name).toBe("is_kyc_verified");
    expect(column.type).toBe("boolean");
    expect(column.default).toBe(false);
    expect(queryRunner.query).toHaveBeenCalledTimes(1);
  });

  it("drops is_kyc_verified column on down when column exists", async () => {
    const queryRunner = createQueryRunnerMock(true);

    await expect(migration.down(queryRunner as never)).resolves.toBeUndefined();

    expect(queryRunner.hasColumn).toHaveBeenCalledWith("users", "is_kyc_verified");
    expect(queryRunner.dropColumn).toHaveBeenCalledWith("users", "is_kyc_verified");
  });

  it("skips dropColumn on down when is_kyc_verified column does not exist", async () => {
    const queryRunner = createQueryRunnerMock(false);

    await expect(migration.down(queryRunner as never)).resolves.toBeUndefined();

    expect(queryRunner.hasColumn).toHaveBeenCalledWith("users", "is_kyc_verified");
    expect(queryRunner.dropColumn).not.toHaveBeenCalled();
  });
});
