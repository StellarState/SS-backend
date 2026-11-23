# Enum writes and legacy projections

The application DataSource installs `EnumValidationSubscriber` for all entities.
Native enum metadata and the central `VARCHAR_ENUMS` registry cover saves,
inserts, partial updates and entity query builder writes. Unknown values reject
with HTTP 400 `INVALID_ENUM_VALUE`, a field name and a correlation ID. Nullable
enums accept null; omitted partial-update fields remain untouched. SQL functions
are not accepted as enum values in these write paths.

Migration `AddEnumQuarantine` adds NOT VALID checks to varchar-backed enum
columns. Existing unknown rows do not block deployment; new raw SQL writes and
updates must satisfy the checks. Native PostgreSQL enum columns already reject
values outside their database type. Migration snapshots are immutable: extend
application enum definitions and add a new database migration together.

On entity hydration, unknown values become null, preserving the rest of a list
response. Null never maps to an approved, active or executable state. Updating
that row requires correcting its enum first. The original value and record ID
are retained in `enum_quarantine`; one compact record per source row/column is
upserted with its most recent observation and correlation ID. No full payload,
credentials or arbitrary object serialization is recorded.

Operators can inspect `SELECT * FROM enum_quarantine ORDER BY observed_at DESC
LIMIT 100`, correlate `enum.projection.quarantined` logs, repair source values,
and remove resolved quarantine records after review. Alert on increases in
`stellarsettle_enum_rejected_writes_total` and
`stellarsettle_enum_quarantined_values_total`. Metrics never label raw values or
wallet IDs. Audit evidence survives migration rollback/reapply.

Use entity queries for projections carrying enum fields. Raw aggregate queries
must explicitly filter to the known enum domain before mapping; subscriber hooks
do not run for raw SQL. Existing issuer/history queries filter their enum domain.
The PostgreSQL integration test covers old varchar values, a database enum with
a newer label, all ORM write methods, raw SQL guards, list responses, nulls,
correlation IDs, metrics and rollback/reapply.
