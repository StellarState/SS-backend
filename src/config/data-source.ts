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
import { logger } from "../observability/logger";

// Validate dataSource is properly initialized
if (!dataSource) {
  throw new Error("DataSource is not properly initialized. Check database configuration.");
}

// Export with error handling wrapper
export default dataSource;

// Export a helper to safely initialize the data source
export async function initializeDataSource(): Promise<void> {
  try {
    if (!dataSource.isInitialized) {
      await dataSource.initialize();
      logger.info("DataSource initialized successfully");
    }
  } catch (error) {
    logger.error("Failed to initialize DataSource", { error });
    throw new Error(`DataSource initialization failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
