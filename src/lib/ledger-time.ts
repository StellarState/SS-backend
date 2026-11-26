/**
 * Ledger time handling for indexed Soroban events (issue #812).
 *
 * Three timestamps are kept apart:
 *
 * - **ledger time** (`ledger_closed_at`): when the ledger containing the
 *   event closed. Authoritative, set once, never changed by a replay, and
 *   the time history is ordered by.
 * - **ingestion time** (`created_at` on `soroban_event_logs`): when the
 *   indexer first saw the event.
 * - **processing time** (`processed_at`): when the event was first projected
 *   successfully. Processing lag is `processed_at - ledger_closed_at`.
 *
 * Processing time must never stand in for ledger time. Callers that cannot
 * get a valid ledger time quarantine the event instead of falling back to
 * `new Date()`.
 */

/** Earliest plausible ledger close time. Stellar's network launched in 2015. */
export const LEDGER_TIME_MIN_MS = Date.UTC(2015, 0, 1);

/** Clock skew tolerated before a ledger time counts as "in the future". */
export const LEDGER_TIME_MAX_FUTURE_SKEW_MS = 5 * 60_000;

export type InvalidLedgerTimeReason =
  "missing" | "unparseable" | "before_network_genesis" | "in_future";

export type LedgerTimeResult =
  { ok: true; value: Date } | { ok: false; reason: InvalidLedgerTimeReason };

/** ISO-8601 date-time with an explicit zone, as Soroban RPC returns it. */
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Strictly parse a ledger close time. Unlike `new Date(raw)`, this rejects
 * zone-less strings (which would parse in the server's local zone), and
 * impossible calendar dates such as Feb 30, which JS silently rolls forward.
 */
export function parseLedgerTime(raw: unknown, now: Date = new Date()): LedgerTimeResult {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime())
      ? { ok: false, reason: "unparseable" }
      : checkRange(raw, now);
  }
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return { ok: false, reason: "missing" };
  }
  if (typeof raw !== "string") return { ok: false, reason: "unparseable" };

  const match = ISO_DATE_TIME.exec(raw.trim());
  if (!match) return { ok: false, reason: "unparseable" };

  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return { ok: false, reason: "unparseable" };
  }

  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) return { ok: false, reason: "unparseable" };
  return checkRange(parsed, now);
}

function checkRange(value: Date, now: Date): LedgerTimeResult {
  if (value.getTime() < LEDGER_TIME_MIN_MS) return { ok: false, reason: "before_network_genesis" };
  if (value.getTime() > now.getTime() + LEDGER_TIME_MAX_FUTURE_SKEW_MS) {
    return { ok: false, reason: "in_future" };
  }
  return { ok: true, value };
}

export class InvalidLedgerTimeError extends Error {
  constructor(
    readonly eventId: string,
    readonly reason: InvalidLedgerTimeReason
  ) {
    super(`Event ${eventId} has an invalid ledger time (${reason}).`);
    this.name = "InvalidLedgerTimeError";
  }
}

/** Processing lag in whole milliseconds, or null when either side is unknown. */
export function processingLagMs(
  ledgerClosedAt: Date | null | undefined,
  processedAt: Date | null | undefined
): number | null {
  if (!ledgerClosedAt || !processedAt) return null;
  return Math.max(0, new Date(processedAt).getTime() - new Date(ledgerClosedAt).getTime());
}
