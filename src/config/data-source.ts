/**
 * DataSource entry point consumed by the TypeORM CLI
 * (`migration:run`, `migration:revert`, `migration:generate`, `migration:show`).
 *
 * This module is intentionally a thin re-export of the application DataSource
 * defined in `./database`, so the CLI and the running application always share
 * exactly one connection configuration. On top of that it performs a
 * fast-failing pre-flight check with actionable logging: a misconfigured
 * environment otherwise surfaces as an opaque driver error deep inside a
 * migration transaction, which is painful to diagnose in CI/CD.
 */
import { logger } from "../observability/logger";
import dataSource from "./database";

/** Normalised runtime environment (trimmed + lower-cased, never undefined). */
const nodeEnv = (process.env.NODE_ENV ?? "development").trim().toLowerCase();

/** In development the app uses a local sqlite file; every other env uses Postgres. */
const isDevelopment = nodeEnv === "development";

/**
 * Validate the environment before the CLI opens a connection.
 *
 * Outside development the CLI runs migrations against Postgres and needs a
 * connection string. Catching a missing/blank `DATABASE_URL` here produces a
 * clear, actionable log line instead of a generic "client password must be a
 * string" / "connection string required" error from the `pg` driver.
 */
function assertMigrationEnvironment(): void {
  if (isDevelopment) return;

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    logger.error("TypeORM CLI cannot start: DATABASE_URL is not set", {
      node_env: nodeEnv,
      hint:
        "Set DATABASE_URL to a Postgres connection string, or run the CLI with " +
        "NODE_ENV=development to target the local sqlite database.",
    });
    throw new Error(
      "DATABASE_URL is required to run database migrations outside development.",
    );
  }
}

assertMigrationEnvironment();

export default dataSource;
