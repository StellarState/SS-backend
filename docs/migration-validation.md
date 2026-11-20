# Migration validation

## Startup

`bootstrap()` in `src/index.ts` calls `ensureDatabaseReady` (`src/config/migration-startup.ts`), which:

1. Initializes the DataSource.
2. Runs preflight (`src/config/migration-preflight.ts`): database reachability, migrations table state, applied migrations unknown to the build, and the pending list.
3. Runs pending migrations explicitly.

A preflight or migration failure throws, and the startup handler logs the message and exits with code 1. Automatic migration on `initialize()` is disabled (`migrationsRun: false` in `src/config/database.ts`) so preflight always runs first. Development (`synchronize: true`) skips both steps.

## Rollback validation

`npm run migrations:validate` (`scripts/validate-migrations.ts`) runs against `DATABASE_URL`:

1. Refuses to run unless the database name contains `test` or `migration`, or `--allow-any` is passed.
2. Runs preflight, then all migrations up.
3. Reverts every migration one at a time, newest first. Any revert error fails with the migration name.
4. Re-runs all migrations up.

Migrations whose `down()` cannot restore the previous state belong in the `IRREVERSIBLE` map in that script with the reason. The map is currently empty; add an entry when a migration is added that cannot be reverted, for example one that adds an enum value.

## CI matrix

Run the validation against an isolated Postgres database for each supported Postgres major version, for example a job matrix over `postgres: [15, 16]` with a service container and `DATABASE_URL` pointing at a database named `migration_validation`. Each job runs `npm run migrations:validate` and fails the build on a non-zero exit.
