# Document exports

Export job metadata is stored in the database. ZIP archives are stored in the
directory configured by `DOCUMENT_EXPORT_SHARED_DIR`; every backend replica
must mount the same durable shared filesystem at that path. The default is
`tmp/document-exports` under the application working directory and is suitable
only for single-instance development.

Completed archives and job metadata are retained for 24 hours by default, and
never less than the signed download token lifetime. Set
`DOCUMENT_EXPORT_RETENTION_HOURS` to a positive integer to change retention,
and `DOCUMENT_EXPORT_CLEANUP_INTERVAL_MS` to change the cleanup schedule
(default one hour). Incomplete archives are removed immediately on failure.
Workers hold a renewable five-minute lease; cleanup marks abandoned jobs as
failed and removes any partial archive.
