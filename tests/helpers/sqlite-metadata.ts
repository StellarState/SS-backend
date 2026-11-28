import { DataSource, type DataSourceOptions, getMetadataArgsStorage } from "typeorm";

type PostgresOnlyType = "timestamptz" | "timestamp" | "jsonb" | "enum";
type MutableColumnOptions = { type?: unknown };

const DEFAULT_SQLITE_TYPES: Record<PostgresOnlyType, string> = {
  timestamptz: "datetime",
  timestamp: "datetime",
  jsonb: "simple-json",
  enum: "varchar",
};

export type SQLiteTypeOverrides = Partial<Record<PostgresOnlyType, string>>;

/**
 * Temporarily rewrite PostgreSQL-only column types for SQLite.
 *
 * TypeORM keeps decorator metadata in a process-global store, so leaving these
 * rewrites in place breaks later PostgreSQL DataSources (for example, they
 * start seeing `datetime` columns). The returned callback must always be
 * invoked after the SQLite DataSource has been initialized.
 */
export function patchMetadataForSQLite(
  overrides: SQLiteTypeOverrides = {}
): () => void {
  const typeMap = { ...DEFAULT_SQLITE_TYPES, ...overrides };
  const originalTypes: Array<{ options: MutableColumnOptions; type: unknown }> = [];

  for (const column of getMetadataArgsStorage().columns) {
    const options = column.options as MutableColumnOptions;
    const type = options.type;
    if (typeof type === "string" && Object.prototype.hasOwnProperty.call(typeMap, type)) {
      originalTypes.push({ options, type });
      options.type = typeMap[type as PostgresOnlyType];
    }
  }

  return () => {
    for (const { options, type } of originalTypes.reverse()) {
      options.type = type;
    }
  };
}

/**
 * Initialize a SQLite DataSource with temporary metadata rewrites, restoring
 * the global TypeORM metadata even when initialization fails.
 */
export async function initializeSQLiteDataSource(
  options: DataSourceOptions,
  overrides: SQLiteTypeOverrides = {}
): Promise<DataSource> {
  const restore = patchMetadataForSQLite(overrides);
  const dataSource = new DataSource(options);
  try {
    await dataSource.initialize();
    return dataSource;
  } catch (error) {
    if (dataSource.isInitialized) await dataSource.destroy().catch(() => undefined);
    throw error;
  } finally {
    restore();
  }
}
