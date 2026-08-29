/**
 * DataSource entry for TypeORM CLI (migration:run, migration:generate, etc.)
 */
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
