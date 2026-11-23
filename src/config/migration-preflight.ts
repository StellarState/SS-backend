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

function migrationName(migration: MigrationInterface): string {
  return migration.name ?? migration.constructor.name;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
