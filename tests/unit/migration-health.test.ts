import request from "supertest";
import type { DataSource, MigrationInterface } from "typeorm";
import { createApp } from "../../src/app";
import { checkMigrationCompatibility } from "../../src/config/migration-preflight";
import type { AuthService } from "../../src/services/auth.service";

const migrations = [{ name: "MigrationOne" }, { name: "MigrationTwo" }] as MigrationInterface[];

function createDataSource({
  applied = [],
  tableExists = true,
  initialized = true,
  type = "postgres",
  queryError,
}: {
  applied?: string[];
  tableExists?: boolean;
  initialized?: boolean;
  type?: "postgres" | "sqlite";
  queryError?: Error;
} = {}) {
  const runner = {
    isTransactionActive: false,
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn(async () => {
      runner.isTransactionActive = true;
    }),
    commitTransaction: jest.fn(async () => {
      runner.isTransactionActive = false;
    }),
    rollbackTransaction: jest.fn(async () => {
      runner.isTransactionActive = false;
    }),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string) => {
      if (queryError) throw queryError;
      if (sql.includes("to_regclass")) return [{ reg: tableExists ? "migrations" : null }];
      if (sql.includes("sqlite_master")) return tableExists ? [{ name: "migrations" }] : [];
      if (sql.startsWith("SELECT name FROM")) {
        return applied.slice(0, migrations.length + 1).map((name) => ({ name }));
      }
      return [];
    }),
  };
  const dataSource = {
    isInitialized: initialized,
    options: { type, migrationsTableName: "migrations" },
    migrations,
    createQueryRunner: jest.fn(() => runner),
  } as unknown as DataSource;

  return { dataSource, runner };
}

function createAuthServiceStub(): AuthService {
  return {
    createChallenge: async () => {
      throw new Error("Not implemented.");
    },
    verifyChallenge: async () => {
      throw new Error("Not implemented.");
    },
    getCurrentUser: async () => {
      throw new Error("Not implemented.");
    },
  } as unknown as AuthService;
}

function createHealthApp(dataSource: DataSource) {
  return createApp({
    authService: createAuthServiceStub(),
    dataSource,
    metricsEnabled: false,
    http: { rateLimit: { enabled: false } },
  });
}

describe("migration compatibility health check", () => {
  it("reports a compatible schema and caps rows read from the migrations table", async () => {
    const { dataSource, runner } = createDataSource({
      applied: ["MigrationOne", "MigrationTwo"],
    });

    await expect(checkMigrationCompatibility(dataSource)).resolves.toMatchObject({
      ok: true,
      status: "compatible",
      pending: [],
      unknown: [],
    });

    expect(runner.query).toHaveBeenCalledWith("SELECT set_config('statement_timeout', $1, true)", [
      "2000ms",
    ]);
    expect(runner.query).toHaveBeenCalledWith('SELECT name FROM "migrations" LIMIT 3');
  });

  it("rejects a schema with missing migrations, including a missing migrations table", async () => {
    const pending = await checkMigrationCompatibility(
      createDataSource({ applied: ["MigrationOne"] }).dataSource
    );
    const missingTable = await checkMigrationCompatibility(
      createDataSource({ tableExists: false }).dataSource
    );

    expect(pending).toMatchObject({
      ok: false,
      status: "pending",
      pending: ["MigrationTwo"],
    });
    expect(missingTable).toMatchObject({
      ok: false,
      status: "pending",
      pending: ["MigrationOne", "MigrationTwo"],
    });
  });

  it("clearly rejects migrations applied by a newer or incompatible build", async () => {
    const result = await checkMigrationCompatibility(
      createDataSource({ applied: ["MigrationOne", "MigrationTwo", "MigrationThree"] }).dataSource
    );

    expect(result).toMatchObject({
      ok: false,
      status: "unknown",
      unknown: ["MigrationThree"],
    });
    expect(result.message).toContain("newer than or incompatible");
  });

  it("supports SQLite migration tables", async () => {
    const { dataSource, runner } = createDataSource({
      applied: ["MigrationOne", "MigrationTwo"],
      type: "sqlite",
    });

    await expect(checkMigrationCompatibility(dataSource)).resolves.toMatchObject({
      ok: true,
      status: "compatible",
    });
    expect(runner.query).toHaveBeenCalledWith(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ["migrations"]
    );
  });

  it("reports database failures as unavailable", async () => {
    const result = await checkMigrationCompatibility(
      createDataSource({ queryError: new Error("connection refused") }).dataSource
    );

    expect(result).toMatchObject({
      ok: false,
      status: "unavailable",
      message: expect.stringContaining("connection refused"),
    });
  });

  it("keeps liveness healthy during an unavailable database", async () => {
    const { dataSource, runner } = createDataSource({ initialized: false });

    const app = createHealthApp(dataSource);
    await request(app).get("/health").expect(200);
    await request(app).get("/ready").expect(503);
    expect(runner.query).not.toHaveBeenCalled();
  });

  it("reports database outages as unavailable readiness", async () => {
    const dataSource = createDataSource({
      queryError: new Error("connection refused"),
    }).dataSource;

    const response = await request(createHealthApp(dataSource)).get("/ready").expect(503);

    expect(response.body.error).toMatchObject({
      code: "DATABASE_UNAVAILABLE",
      message: expect.stringContaining("connection refused"),
    });
  });

  it("fails readiness for missing migrations and identifies unknown migrations", async () => {
    const pendingDataSource = createDataSource({ applied: ["MigrationOne"] }).dataSource;
    const newerDataSource = createDataSource({
      applied: ["MigrationOne", "MigrationTwo", "MigrationThree"],
    }).dataSource;

    const pendingResponse = await request(createHealthApp(pendingDataSource))
      .get("/ready")
      .expect(503);
    const newerResponse = await request(createHealthApp(newerDataSource)).get("/ready").expect(503);

    expect(pendingResponse.body).toMatchObject({
      error: { code: "MIGRATIONS_PENDING" },
      data: { status: "not_ready", migrations: { status: "pending" } },
    });
    expect(newerResponse.body).toMatchObject({
      error: { code: "UNKNOWN_MIGRATIONS" },
      data: { migrations: { status: "unknown", unknown: ["MigrationThree"] } },
    });
  });
});
