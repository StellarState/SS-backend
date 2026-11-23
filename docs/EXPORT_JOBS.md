# Export jobs: progress, polling and cancellation

Bulk document export (`POST /api/v1/invoices/:id/documents/export`) runs as a
background job. This page describes how to follow a job and how to cancel it.
All routes need a bearer token. Only the user who requested the export can
inspect or cancel it.

## States

| State | Meaning |
|---|---|
| `queued` | Accepted, not started yet |
| `running` | Fetching documents and building the ZIP |
| `completed` | The ZIP is ready; `downloadUrl` is present |
| `failed` | The job stopped with an error; `error` is present |
| `cancelled` | Cancelled by the requester; no download is offered |

`completed`, `failed` and `cancelled` are final. A job never leaves a final
state.

```
queued -> running -> completed
   |         |-----> failed
   |         '-----> cancelled
   |-> cancelled | failed
```

## Progress

`progress` is a whole number from 0 to 100.

- It never goes down.
- It reaches 100 only when the job is `completed`. While running it stops at
  99, so a client can treat 100 as "the file is ready".
- `processedDocuments` and `totalDocuments` give the same information as a count.
  `totalDocuments` is 0 until the job starts.

## Polling

```
GET /api/v1/invoices/:id/documents/export/:jobId
```

```json
{
  "success": true,
  "data": {
    "jobId": "exp_...",
    "status": "running",
    "progress": 40,
    "processedDocuments": 4,
    "totalDocuments": 10,
    "createdAt": "2026-11-21T07:00:00.000Z"
  }
}
```

Recommended client behaviour:

1. Start with a 1 second interval and back off to about 5 seconds for long jobs.
2. Stop as soon as `status` is `completed`, `failed` or `cancelled`.
3. On `completed`, download from `downloadUrl` before `expiresAt`. If the link
   has expired, request a new export.
4. A `404 export_job_not_found` means the id is unknown, belongs to another
   user, or belongs to a different invoice. These cases are not distinguished.

## Cancellation

```
DELETE /api/v1/invoices/:id/documents/export/:jobId
```

| Job state | Result |
|---|---|
| `queued` or `running` | `200`, the job becomes `cancelled` |
| `cancelled` | `200`, the job is returned unchanged (idempotent) |
| `completed` or `failed` | `409 export_not_cancellable` |
| unknown or not yours | `404 export_job_not_found` |

Cancelling is safe to retry. If a cancel and the job finishing happen at nearly
the same moment, whichever is applied first wins: a job that completed first
returns `409`, and a job cancelled first never becomes `completed`. A running
export stops fetching documents and discards any partial ZIP.

## Limits

Jobs are held in memory by the API process. They are lost on restart and are
not shared between instances, so poll the same instance that created the job.
