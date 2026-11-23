import "reflect-metadata";
import { DataSource } from "typeorm";
import { runPreflight } from "../src/config/migration-preflight";

const IRREVERSIBLE: Record<string, string> = {};

function fail(message: string): never {
  console.error(`migration validation failed: ${message}`);
  process.exit(1);
}

function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

async function runUp(dataSource: DataSource, label: string): Promise<void> {
  try {
    const applied = await dataSource.runMigrations();
    console.log(`[${label}] applied ${applied.length} migration(s)`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[${label}] up failed: ${reason}`);
  }
}

async function revertAll(dataSource: DataSource): Promise<void> {
  for (;;) {
    const rows = (await dataSource.query(
      'SELECT name FROM "migrations" ORDER BY timestamp DESC LIMIT 1',
    )) as Array<{ name: string }>;
    if (rows.length === 0) {
      return;
    }
    const name = rows[0].name;
    try {
      await dataSource.undoLastMigration();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`revert failed for ${name}: ${reason}`);
    }
    const note = IRREVERSIBLE[name];
    console.log(note ? `reverted ${name} (irreversible: ${note})` : `reverted ${name}`);
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    fail("DATABASE_URL is required.");
  }

  const allowAny = process.argv.includes("--allow-any");
  const dbName = databaseNameOf(url);
  if (!allowAny && !/test|migration/i.test(dbName)) {
    fail(
      `refusing to run against database "${dbName}". Use an isolated database whose name contains "test" or "migration", or pass --allow-any.`,
    );
  }

  const dataSource = new DataSource({
    type: "postgres",
    url,
    migrations: ["src/migrations/*.ts"],
    migrationsTableName: "migrations",
    migrationsTransactionMode: "each",
  });

  await dataSource.initialize();
  try {
    const preflight = await runPreflight(dataSource);
    if (!preflight.ok) {
      const failures = preflight.checks.filter((check) => !check.ok).map((check) => check.message);
      fail(`preflight: ${failures.join(" | ")}`);
    }

    await runUp(dataSource, "initial up");
    await revertAll(dataSource);
    await runUp(dataSource, "re-run up");
    console.log("migration validation passed");
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
