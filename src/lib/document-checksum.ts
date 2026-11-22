import { createHash } from "node:crypto";
import { ServiceError } from "../utils/service-error";

export function parseContentChecksum(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new ServiceError("invalid_checksum", "content_checksum must be a SHA256 hex digest", 400);
  }
  return value.toLowerCase();
}

export function verifyDocumentChecksum(bytes: Buffer, expected: string | null): string {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (expected !== null && actual !== expected) {
    throw new ServiceError(
      "checksum_mismatch",
      "Document bytes do not match content_checksum",
      409
    );
  }
  return actual;
}
