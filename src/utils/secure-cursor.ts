import crypto from "crypto";
import { ServiceError } from "./service-error";

/**
 * Opaque, tamper-proof pagination cursors (issue #559).
 *
 * A cursor carries the keyset position of the last row on a page: the value
 * of the sort column and the row id. It is sealed with AES-256-GCM, so the
 * client can neither read the raw id nor edit the position; any change fails
 * the authentication tag and is rejected as an invalid cursor.
 *
 * Each cursor is also bound to the endpoint (`scope`) and the sort it was
 * issued for, so a cursor from one list cannot be replayed against another.
 */

export type CursorValue = string | number | Date;

export interface CursorPosition {
  /** Sort key the cursor was issued for, e.g. "created_at". */
  sort: string;
  order: "ASC" | "DESC";
  /** Value of the sort column on the last row of the page. */
  value: CursorValue;
  /** Id of the last row of the page, the tiebreaker. */
  id: string;
}

interface SealedPayload {
  s: string;
  o: "ASC" | "DESC";
  /** Value type, so dates come back as Date objects. */
  t: "date" | "string" | "number";
  v: string | number;
  i: string;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

// Used only when neither CURSOR_SECRET nor JWT_SECRET is set (some tests).
// Cursors then stay valid for the life of the process, which is all a
// pagination cursor needs.
let processFallbackSecret: string | null = null;

function cursorKey(): Buffer {
  const secret =
    process.env.CURSOR_SECRET ||
    process.env.JWT_SECRET ||
    (processFallbackSecret ??= crypto.randomBytes(32).toString("hex"));
  return crypto.createHash("sha256").update(`pagination-cursor:${secret}`).digest();
}

export function invalidCursorError(message = "Invalid or expired pagination cursor."): ServiceError {
  return new ServiceError("invalid_cursor", message, 400);
}

export function encodeSecureCursor(scope: string, position: CursorPosition): string {
  const payload: SealedPayload = {
    s: position.sort,
    o: position.order,
    t:
      position.value instanceof Date
        ? "date"
        : typeof position.value === "number"
          ? "number"
          : "string",
    v: position.value instanceof Date ? position.value.toISOString() : position.value,
    i: position.id,
  };

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", cursorKey(), iv);
  cipher.setAAD(Buffer.from(scope, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

/**
 * Opens a cursor issued by {@link encodeSecureCursor} for the same `scope`.
 *
 * @throws ServiceError 400 `invalid_cursor` for anything that is not an
 *   untampered cursor from this endpoint.
 */
export function decodeSecureCursor(scope: string, cursor: string): CursorPosition {
  const raw = Buffer.from(cursor.trim(), "base64url");
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw invalidCursorError();
  }

  let payload: SealedPayload;
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      cursorKey(),
      raw.subarray(0, IV_BYTES)
    );
    decipher.setAAD(Buffer.from(scope, "utf8"));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
    payload = JSON.parse(plaintext) as SealedPayload;
  } catch {
    throw invalidCursorError();
  }

  if (
    typeof payload?.s !== "string" ||
    (payload.o !== "ASC" && payload.o !== "DESC") ||
    typeof payload.i !== "string" ||
    (typeof payload.v !== "string" && typeof payload.v !== "number")
  ) {
    throw invalidCursorError();
  }

  let value: CursorValue = payload.v;
  if (payload.t === "date") {
    value = new Date(payload.v);
    if (Number.isNaN(value.getTime())) throw invalidCursorError();
  }

  return { sort: payload.s, order: payload.o, value, id: payload.i };
}
