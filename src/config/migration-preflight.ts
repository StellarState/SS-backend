import type { DataSource, MigrationInterface } from "typeorm";

export interface PreflightCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  pending: string[];
}

export interface MigrationCompatibilityResult {
  ok: boolean;
  status: "compatible" | "pending" | "unknown" | "unavailable";
  pending: string[];
  unknown: string[];
  message: string;
}

const HEALTH_QUERY_TIMEOUT_MS = 2_000;

function migrationName(migration: MigrationInterface): string {
  return migration.name ?? migration.constructor.name;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export async function checkMigrationCompatibility(
  dataSource: DataSource
): Promise<MigrationCompatibilityResult> {
  const known = dataSource.migrations.map(migrationName);
  const table = dataSource.options.migrationsTableName ?? "migrations";
  const queryRunner = dataSource.createQueryRunner();

  try {
    await queryRunner.connect();
    await queryRunner.startTransaction();

    if (dataSource.options.type === "postgres") {
      await queryRunner.query("SELECT set_config('statement_timeout', $1, true)", [
        `${HEALTH_QUERY_TIMEOUT_MS}ms`,
      ]);
    }

    let tableExists: boolean;
    if (dataSource.options.type === "postgres") {
      const rows = (await queryRunner.query("SELECT to_regclass($1) AS reg", [
        `public.${quoteIdentifier(table)}`,
      ])) as Array<{ reg: string | null }>;
      tableExists = rows[0]?.reg != null;
    } else {
      const rows = (await queryRunner.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        [table]
      )) as Array<{ name: string }>;
      tableExists = rows.length > 0;
    }

    const applied = tableExists
      ? (
          (await queryRunner.query(
            `SELECT name FROM ${quoteIdentifier(table)} LIMIT ${known.length + 1}`
          )) as Array<{ name: string }>
        ).map((row) => row.name)
      : [];
    const unknown = applied.filter((name) => !known.includes(name));
    const pending = known.filter((name) => !applied.includes(name));

    await queryRunner.commitTransaction();

    if (unknown.length > 0 || applied.length > known.length) {
      return {
        ok: false,
        status: "unknown",
        pending,
        unknown,
        message:
          unknown.length > 0
            ? `Database schema is newer than or incompatible with this build; unknown migrations: ${unknown.join(", ")}.`
            : "Database schema contains more migrations than this build knows about.",
      };
    }

    if (pending.length > 0) {
      return {
        ok: false,
        status: "pending",
        pending,
        unknown: [],
        message: `Database schema is missing required migrations: ${pending.join(", ")}.`,
      };
    }

    return {
      ok: true,
      status: "compatible",
      pending: [],
      unknown: [],
      message: "Database schema is compatible with this build.",
    };
  } catch (error) {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }

    return {
      ok: false,
      status: "unavailable",
      pending: [],
      unknown: [],
      message: `Unable to verify database migration compatibility: ${reasonOf(error)}.`,
    };
  } finally {
    await queryRunner.release();
  }
}

export async function runPreflight(dataSource: DataSource): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];

  try {
    await dataSource.query("SELECT 1");
    checks.push({ name: "database_reachable", ok: true, message: "Database is reachable." });
  } catch (error) {
    checks.push({
      name: "database_reachable",
      ok: false,
      message: `Database is unreachable: ${reasonOf(error)}. Check DATABASE_URL and that the database server is running.`,
    });
    return { ok: false, checks, pending: [] };
  }

  const table = dataSource.options.migrationsTableName ?? "migrations";
  let tableExists = true;
  if (dataSource.options.type === "postgres") {
    const rows = (await dataSource.query("SELECT to_regclass($1) AS reg", [`public.${table}`])) as Array<{
      reg: string | null;
    }>;
    tableExists = rows[0]?.reg != null;
  }
  checks.push({
    name: "migrations_table",
    ok: true,
    message: tableExists
      ? `Migrations table "${table}" exists.`
      : `Migrations table "${table}" does not exist yet and will be created.`,
  });

  const known = dataSource.migrations.map(migrationName);
  const applied: string[] = tableExists
    ? ((await dataSource.query(`SELECT name FROM "${table}"`)) as Array<{ name: string }>).map(
        (row) => row.name,
      )
    : [];

  const unknown = applied.filter((name) => !known.includes(name));
  checks.push({
    name: "no_unknown_migrations",
    ok: unknown.length === 0,
    message:
      unknown.length === 0
        ? "Every applied migration is known to this build."
        : `Database has migrations unknown to this build: ${unknown.join(", ")}. Deploy the code version that defines them, or restore the matching schema, before starting.`,
  });

  const pending = known.filter((name) => !applied.includes(name));
  checks.push({
    name: "pending_migrations",
    ok: true,
    message: `${pending.length} pending migration(s)${pending.length ? `: ${pending.join(", ")}` : ""}.`,
  });

  return { ok: checks.every((check) => check.ok), checks, pending };
}
