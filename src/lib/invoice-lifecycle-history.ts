import { ServiceError } from "../utils/service-error";
import type { InvoiceStatus } from "../types/enums";
import type { InvoiceTransitionActorRole } from "../models/InvoiceStatusHistory.model";

/**
 * Invoice lifecycle history (issue #795): cursor codec, page bounds and
 * redaction for GET /api/v1/invoices/:id/history.
 *
 * Ordering is (created_at ASC, id ASC). created_at alone is not unique:
 * Postgres `now()` is fixed for a whole transaction, so several transitions
 * written together share a timestamp. The id tie-break makes the order total
 * and therefore stable across pages.
 *
 * The cursor carries the row's created_at at full microsecond precision as
 * Postgres prints it. A JavaScript Date only keeps milliseconds; a cursor
 * built from one would compare as earlier than the row it came from, and
 * the next page would repeat that row.
 */

export const LIFECYCLE_HISTORY_DEFAULT_LIMIT = 50;
export const LIFECYCLE_HISTORY_MAX_LIMIT = 100;

export interface LifecycleHistoryCursor {
  invoiceId: string;
  /** created_at as an ISO 8601 UTC string with microseconds. */
  createdAt: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXACT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function invalidCursor(): ServiceError {
  return new ServiceError("invalid_cursor", "Invalid history cursor", 400);
}

export function encodeLifecycleHistoryCursor(cursor: LifecycleHistoryCursor): string {
  return Buffer.from(
    JSON.stringify({ v: 1, i: cursor.invoiceId, t: cursor.createdAt, id: cursor.id })
  ).toString("base64url");
}

/**
 * Decodes a cursor issued for `invoiceId`. A cursor from another invoice is
 * rejected like a malformed one, so cursors cannot be replayed across
 * invoices.
 */
export function decodeLifecycleHistoryCursor(
  raw: string,
  invoiceId: string
): LifecycleHistoryCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  const value = parsed as { v?: unknown; i?: unknown; t?: unknown; id?: unknown } | null;
  if (
    !value ||
    value.v !== 1 ||
    value.i !== invoiceId ||
    typeof value.t !== "string" ||
    !EXACT_TIMESTAMP.test(value.t) ||
    Number.isNaN(Date.parse(value.t)) ||
    typeof value.id !== "string" ||
    !UUID.test(value.id)
  ) {
    throw invalidCursor();
  }
  return { invoiceId, createdAt: value.t, id: value.id };
}

/** Parses `limit`: default 50, integer 1..100, otherwise 400. */
export function parseLifecycleHistoryLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return LIFECYCLE_HISTORY_DEFAULT_LIMIT;
  const text = String(raw).trim();
  const limit = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIFECYCLE_HISTORY_MAX_LIMIT) {
    throw new ServiceError(
      "invalid_limit",
      `limit must be an integer between 1 and ${LIFECYCLE_HISTORY_MAX_LIMIT}`,
      400
    );
  }
  return limit;
}

export interface LifecycleHistoryViewer {
  id: string;
  stellarAddress?: string | null;
  isAdmin: boolean;
}

export interface LifecycleHistoryRow {
  id: string;
  fromStatus: InvoiceStatus;
  toStatus: InvoiceStatus;
  actorRole: InvoiceTransitionActorRole;
  actorId: string | null;
  trigger: string;
  reason: string | null;
  createdAt: Date;
}

export interface LifecycleHistoryEntry {
  id: string;
  fromStatus: InvoiceStatus;
  toStatus: InvoiceStatus;
  /** Actor category: "seller", "admin" or "system". */
  actorRole: InvoiceTransitionActorRole;
  /**
   * Who acted. Admins see every actor. Sellers see only their own id; the
   * identities of admins and system jobs are redacted to null.
   */
  actorId: string | null;
  trigger: string;
  reason: string | null;
  createdAt: Date;
}

export function redactLifecycleHistoryRow(
  row: LifecycleHistoryRow,
  viewer: LifecycleHistoryViewer
): LifecycleHistoryEntry {
  const isSelf =
    row.actorId !== null &&
    (row.actorId === viewer.id ||
      (!!viewer.stellarAddress && row.actorId === viewer.stellarAddress));
  return {
    id: row.id,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    actorRole: row.actorRole,
    actorId: viewer.isAdmin || isSelf ? row.actorId : null,
    trigger: row.trigger,
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

export interface LifecycleHistoryPage {
  items: LifecycleHistoryEntry[];
  hasMore: boolean;
  nextCursor: string | null;
  limit: number;
}
