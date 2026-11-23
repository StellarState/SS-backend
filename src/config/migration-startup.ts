import type { DataSource } from "typeorm";
import { logger } from "../observability/logger";
import { runPreflight } from "./migration-preflight";

export async function ensureDatabaseReady(dataSource: DataSource): Promise<void> {
  if (!dataSource.isInitialized) {
    await dataSource.initialize();
  }

  if (dataSource.options.synchronize) {
    return;
  }

  const preflight = await runPreflight(dataSource);
  if (!preflight.ok) {
    const failures = preflight.checks.filter((check) => !check.ok).map((check) => check.message);
    logger.error("Migration preflight failed; refusing to start", { failures });
    throw new Error(`Migration preflight failed:\n - ${failures.join("\n - ")}`);
  }

  try {
    const applied = await dataSource.runMigrations();
    logger.info("Migrations applied", {
      count: applied.length,
      names: applied.map((migration) => migration.name),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error("Migration run failed; refusing to start", { error: reason });
    throw new Error(`Migration run failed: ${reason}`);
  }
}
