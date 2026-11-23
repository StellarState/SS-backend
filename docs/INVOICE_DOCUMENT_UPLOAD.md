# Invoice Document Upload Feature

This document describes the invoice document upload feature that allows sellers to attach tamper-evident supporting documents (PDFs, images) to their invoices using IPFS storage.

## Overview

The feature provides a secure endpoint for sellers to upload supporting documents for their invoices. Documents are stored on IPFS (via Pinata) and the resulting hash is stored in the invoice record for tamper-evident verification.

## API Endpoint

### Upload Invoice Document

**POST** `/api/v1/invoices/:id/document`

Uploads a supporting document for a seller-owned invoice.

#### Authentication
- Requires JWT Bearer token
- Only the invoice seller can upload documents to their invoices

#### Request
- **Content-Type**: `multipart/form-data`
- **Form field**: `document` (file)

#### Rate Limiting
- 10 uploads per 15 minutes per user
- Configurable via environment variables

#### File Restrictions
- **Max file size**: 10MB (configurable)
- **Allowed MIME types**: 
  - `application/pdf`
  - `image/jpeg`
  - `image/png`
  - `image/gif`
  - `image/webp`

#### Response

**Success (200)**
```json
{
  "success": true,
  "data": {
    "invoiceId": "uuid",
    "ipfsHash": "QmHash123...",
    "fileSize": 1024,
    "uploadedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

**Error Responses**
- `400` - Missing file, invalid file type, or file too large
- `401` - Authentication required or invalid token
- `403` - Unauthorized access (not the invoice seller)
- `404` - Invoice not found
- `429` - Rate limit exceeded
- `500` - Server error or IPFS upload failure

## Environment Configuration

Add these variables to your `.env` file:

```env
# IPFS Configuration (Required)
IPFS_API_URL=https://api.pinata.cloud
IPFS_JWT=your_pinata_jwt_token

# Optional Configuration
IPFS_MAX_FILE_SIZE_MB=10
IPFS_ALLOWED_MIME_TYPES=application/pdf,image/jpeg,image/png,image/gif,image/webp
IPFS_UPLOAD_RATE_LIMIT_WINDOW_MS=900000
IPFS_UPLOAD_RATE_LIMIT_MAX_UPLOADS=10
```

### Obtaining Pinata Credentials

1. Sign up at [Pinata](https://pinata.cloud/)
2. Create an API key with pinning permissions
3. Use the API key as your `IPFS_JWT` value
4. Use `https://api.pinata.cloud` as your `IPFS_API_URL`

## Usage Example

```bash
# Upload a PDF document
curl -X POST \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -F "document=@invoice-receipt.pdf" \
  http://localhost:3000/api/v1/invoices/invoice-uuid/document
```

## Security Features

- **Authentication**: Only authenticated users can upload
- **Authorization**: Only invoice sellers can upload to their invoices
- **File validation**: MIME type and size restrictions
- **Rate limiting**: Prevents abuse
- **Tamper evidence**: IPFS hash provides content verification
- **Privacy**: No PII is logged during upload process

## Database Changes

The `invoices.ipfs_hash` column stores the IPFS hash of the uploaded document. This field:
- Is nullable (invoices can exist without documents)
- Stores the IPFS content identifier (CID)
- Provides tamper-evident verification of document integrity

## Error Handling

The service provides stable error codes for different failure scenarios:

- `file_too_large` - File exceeds size limit
- `invalid_file_type` - MIME type not allowed
- `invoice_not_found` - Invoice doesn't exist
- `unauthorized_invoice_access` - User doesn't own the invoice
- `ipfs_upload_failed` - IPFS service error
- `ipfs_upload_error` - Network or unexpected error

## Testing

The feature includes comprehensive tests:
- Unit tests for IPFS service
- Unit tests for invoice service
- Integration tests for HTTP endpoints
- Mock IPFS responses for CI/CD

All tests mock the Pinata API and require no real JWT credentials to run.

## Retention and Privacy

- Documents are stored on IPFS via Pinata
- IPFS hashes are immutable and provide tamper evidence
- No personally identifiable information (PII) is logged during uploads
- Document retention follows Pinata's retention policies
- Consider implementing document lifecycle management for compliance

## Resumable uploads and integrity (#826)

The original multipart `POST /api/v1/invoices/{id}/document` accepts optional
`content_checksum` (64 hexadecimal SHA256 characters). The server hashes the
received bytes before pinning and returns `contentChecksum` and `uploadComplete`.
A checksum mismatch returns 409 `checksum_mismatch` without changing the document.
Legacy documents without checksum metadata remain supported.

For resumable uploads on a seller-owned draft:

1. `POST /api/v1/invoices/{id}/uploads` with JSON `filename`, `mime_type`,
   `file_size_bytes`, optional `content_checksum`, and optional UUID
   `upload_session_id`. Reusing the same ID with the same metadata returns the
   existing session. Metadata changes require a new session. The total size and
   MIME type follow the existing IPFS configuration; raise `IPFS_MAX_FILE_SIZE_MB`
   to accept larger documents. Only one pending upload is allowed per invoice.
2. `PATCH /api/v1/invoices/{id}/uploads/{sessionId}` sends raw
   `application/octet-stream` bytes with integer `Upload-Offset`. Chunks are
   sequential and at most 1 MiB. Acknowledged bytes are durable in PostgreSQL.
   Replaying the same offset and identical bytes is idempotent; gaps, changed
   retries, and overruns return 409 with `received_bytes`.
3. `GET /api/v1/invoices/{id}/uploads/{sessionId}` returns `received_bytes`,
   `state`, `upload_complete`, checksum, CID and immutable file metadata. Resume
   at that offset, including after an application restart.
4. `POST /api/v1/invoices/{id}/uploads/{sessionId}/complete` requires all bytes,
   verifies SHA256, pins the document, and persists verified invoice and document
   metadata atomically. A completed retry returns the stored result. A checksum
   or gateway failure leaves the pending session and acknowledged bytes intact.
5. `POST /api/v1/invoices/{id}/uploads/{sessionId}/restart` discards the pending
   chunks and returns a new session UUID starting at zero. Delayed requests on
   the old UUID return 409 `upload_state_conflict`. An optional JSON body can
   replace `filename`, `mime_type`, `file_size_bytes` or `content_checksum`,
   allowing a bad checksum or changed file to be corrected. Omitted fields
   retain their original values; a null checksum removes the supplied digest.

An upload in progress blocks submission and publication even if an older CID is
attached. Verification flags are server controlled. Registering checksum
metadata through `/documents` requires a completed session with matching invoice,
CID, checksum and byte count. The completion request assembles the configured
maximum file in memory and holds the invoice/session locks through pinning; size
limits should reflect available memory and gateway latency. Retained chunks
allow exact completion retries; pending uploads do not expire automatically.
