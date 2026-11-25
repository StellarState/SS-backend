import { Decimal } from "decimal.js";
import type { DataSource } from "typeorm";
import { ServiceError } from "../utils/service-error";
import { computeInvestorReturn } from "../lib/investor-return";
import { decimalStringToScaledBigInt, scaledBigIntToDecimalString } from "../lib/decimal-bigint";

/**
 * Settlement history for one investor wallet (issue #782):
 * GET /api/v1/investors/:wallet/settlements and its CSV export.
 *
 * One record per settled investment, built from what settlement wrote in the
 * same transaction (settlement.service.ts):
 *
 * - `investor_returns.return_amount` — what the investor was paid (net of
 *   the platform fee); its `created_at` is the settlement time.
 * - `investments.investment_amount` — what the investor put in.
 * - `settlement_remainders` — the invoice's total proceeds, the amount
 *   distributed and the rounding remainder, from which the platform fee is
 *   recovered: fee = proceeds - distributed - remainder.
 *
 * Every figure uses the same pro-rata floor division as the payout itself
 * (lib/investor-return.ts), at the 4-decimal scale of the money columns:
 *
 * | field              | definition                                                   |
 * | ------------------ | ------------------------------------------------------------ |
 * | invested_amount    | investment_amount                                            |
 * | fractions_held     | invested_amount / total invested by all settled holders      |
 * | fees               | floor(invested_amount × invoice fee / total invested)        |
 * | payout_amount      | return_amount                                                |
 * | principal_returned | min(payout_amount + fees, invested_amount)                   |
 * | yield_earned       | payout_amount + fees − principal_returned                    |
 * | net_return_usd     | payout_amount − invested_amount (negative for a loss)        |
 * | net_return_pct     | net_return_usd / invested_amount × 100, 4 decimals           |
 *
 * Settlements recorded before `settlement_remainders` existed have no fee
 * data; their `fees` is "0.0000" and `fee_data_available` is false.
 */

export const SETTLEMENT_HISTORY_DEFAULT_LIMIT = 20;
export const SETTLEMENT_HISTORY_MAX_LIMIT = 100;
/** Exports larger than this must be narrowed with a date range. */
export const SETTLEMENT_EXPORT_MAX_ROWS = 10_000;

/**
 * Bounds are passed to Postgres as text, not as JavaScript Dates: settlement
 * times have microseconds and a Date would round a bound to milliseconds.
 */
export interface SettlementHistoryFilters {
  /** Inclusive lower bound on settled_at. */
  from?: string;
  /** Inclusive upper bound on settled_at (an explicit timestamp). */
  to?: string;
  /** Exclusive upper bound (a bare to_date: the start of the next UTC day). */
  before?: string;
  /** Matches the invoice category, case-insensitively. */
  invoiceType?: string;
}

export interface SettlementRecord {
  invoice_id: string;
  invoice_number: string;
  invoice_type: string | null;
  settled_at: string;
  fractions_held: string;
  invested_amount: string;
  payout_amount: string;
  principal_returned: string;
  yield_earned: string;
  fees: string;
  fee_data_available: boolean;
  net_return_usd: string;
  net_return_pct: string;
}

export interface SettlementHistoryPage {
  items: SettlementRecord[];
  hasMore: boolean;
  nextCursor: string | null;
  limit: number;
}

interface SettlementRow {
  return_id: string;
  invoice_id: string;
  invoice_number: string;
  invoice_type: string | null;
  settled_at_exact: string;
  invested_amount: string;
  payout_amount: string;
  total_invested: string;
  total_settlement_amount: string | null;
  total_distributed_amount: string | null;
  remainder_amount: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXACT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

interface Cursor {
  settledAt: string;
  id: string;
}

export function encodeSettlementCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ v: 1, t: cursor.settledAt, id: cursor.id })).toString(
    "base64url"
  );
}

export function decodeSettlementCursor(raw: string): Cursor {
  let parsed: { v?: unknown; t?: unknown; id?: unknown } | null = null;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    // handled below
  }
  if (
    !parsed ||
    parsed.v !== 1 ||
    typeof parsed.t !== "string" ||
    !EXACT_TIMESTAMP.test(parsed.t) ||
    typeof parsed.id !== "string" ||
    !UUID.test(parsed.id)
  ) {
    throw new ServiceError("INVALID_CURSOR", "Invalid settlements cursor", 400);
  }
  return { settledAt: parsed.t, id: parsed.id };
}

export function parseSettlementLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return SETTLEMENT_HISTORY_DEFAULT_LIMIT;
  const text = String(raw).trim();
  const limit = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > SETTLEMENT_HISTORY_MAX_LIMIT) {
    throw new ServiceError(
      "INVALID_LIMIT",
      `limit must be an integer between 1 and ${SETTLEMENT_HISTORY_MAX_LIMIT}`,
      400
    );
  }
  return limit;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parses from_date / to_date / invoice_type. A bare date (YYYY-MM-DD) covers
 * the whole UTC day: from_date starts at 00:00:00Z and to_date runs up to,
 * but not including, 00:00:00Z of the next day, so from_date=to_date=D
 * returns everything settled on D. Timestamps must carry Z or an offset and
 * are inclusive.
 */
export function parseSettlementFilters(query: {
  from_date?: unknown;
  to_date?: unknown;
  invoice_type?: unknown;
}): SettlementHistoryFilters {
  const read = (raw: unknown, field: string): { text: string; dateOnly: boolean } | undefined => {
    if (raw === undefined || raw === null || raw === "") return undefined;
    const text = String(raw).trim();
    const dateOnly = DATE_ONLY.test(text);
    const probe = new Date(dateOnly ? `${text}T00:00:00Z` : text);
    const calendarOk =
      Number.isNaN(probe.getTime()) || !dateOnly || probe.toISOString().slice(0, 10) === text;
    if ((!dateOnly && !TIMESTAMP.test(text)) || Number.isNaN(probe.getTime()) || !calendarOk) {
      throw new ServiceError(
        "INVALID_DATE",
        `${field} must be an ISO 8601 date (YYYY-MM-DD) or a timestamp with a timezone`,
        400
      );
    }
    return { text, dateOnly };
  };

  const fromRaw = read(query.from_date, "from_date");
  const toRaw = read(query.to_date, "to_date");

  const filters: SettlementHistoryFilters = {};
  if (fromRaw) filters.from = fromRaw.dateOnly ? `${fromRaw.text}T00:00:00Z` : fromRaw.text;
  if (toRaw) {
    if (toRaw.dateOnly) {
      const next = new Date(`${toRaw.text}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      filters.before = next.toISOString();
    } else {
      filters.to = toRaw.text;
    }
  }

  const lower = filters.from ? Date.parse(filters.from) : undefined;
  const upper = filters.to
    ? Date.parse(filters.to)
    : filters.before
      ? Date.parse(filters.before)
      : undefined;
  if (
    lower !== undefined &&
    upper !== undefined &&
    (filters.before ? lower >= upper : lower > upper)
  ) {
    throw new ServiceError("INVALID_DATE_RANGE", "from_date must not be after to_date", 400);
  }

  if (query.invoice_type !== undefined && query.invoice_type !== "") {
    const invoiceType = String(query.invoice_type).trim();
    if (!invoiceType || invoiceType.length > 64) {
      throw new ServiceError(
        "INVALID_INVOICE_TYPE",
        "invoice_type must be between 1 and 64 characters",
        400
      );
    }
    filters.invoiceType = invoiceType;
  }

  return filters;
}

/** Pure per-settlement arithmetic; exported for tests. */
export function computeSettlementRecord(row: SettlementRow): SettlementRecord {
  const invested = decimalStringToScaledBigInt(new Decimal(row.invested_amount).toFixed(4));
  const payout = decimalStringToScaledBigInt(new Decimal(row.payout_amount).toFixed(4));
  const totalInvested = decimalStringToScaledBigInt(new Decimal(row.total_invested).toFixed(4));

  const feeDataAvailable =
    row.total_settlement_amount !== null &&
    row.total_distributed_amount !== null &&
    row.remainder_amount !== null;
  let invoiceFee = 0n;
  if (feeDataAvailable) {
    const scaled = (v: string) => decimalStringToScaledBigInt(new Decimal(v).toFixed(4));
    invoiceFee =
      scaled(row.total_settlement_amount!) -
      scaled(row.total_distributed_amount!) -
      scaled(row.remainder_amount!);
    if (invoiceFee < 0n) invoiceFee = 0n;
  }

  const fees =
    totalInvested > 0n && invoiceFee > 0n
      ? computeInvestorReturn(invested, totalInvested, invoiceFee)
      : 0n;
  const gross = payout + fees;
  const principal = gross < invested ? gross : invested;
  const yieldEarned = gross - principal;
  const net = payout - invested;

  const netPct =
    invested > 0n
      ? new Decimal(net.toString()).div(invested.toString()).mul(100).toFixed(4)
      : "0.0000";
  const share =
    totalInvested > 0n
      ? new Decimal(invested.toString()).div(totalInvested.toString()).toFixed(6)
      : "0.000000";

  return {
    invoice_id: row.invoice_id,
    invoice_number: row.invoice_number,
    invoice_type: row.invoice_type,
    settled_at: row.settled_at_exact.replace(/(\.\d{3})\d{3}Z$/, "$1Z"),
    fractions_held: share,
    invested_amount: scaledBigIntToDecimalString(invested),
    payout_amount: scaledBigIntToDecimalString(payout),
    principal_returned: scaledBigIntToDecimalString(principal),
    yield_earned: scaledBigIntToDecimalString(yieldEarned),
    fees: scaledBigIntToDecimalString(fees),
    fee_data_available: feeDataAvailable,
    net_return_usd: scaledBigIntToDecimalString(net),
    net_return_pct: netPct,
  };
}

export const SETTLEMENT_CSV_COLUMNS: Array<keyof SettlementRecord> = [
  "invoice_id",
  "invoice_number",
  "invoice_type",
  "settled_at",
  "fractions_held",
  "invested_amount",
  "payout_amount",
  "principal_returned",
  "yield_earned",
  "fees",
  "fee_data_available",
  "net_return_usd",
  "net_return_pct",
];

/** Text cells that a spreadsheet would run as a formula get a leading quote. */
function csvCell(value: unknown, isText: boolean): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (isText && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || (isText && text.startsWith("'"))
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

const TEXT_COLUMNS = new Set<keyof SettlementRecord>(["invoice_number", "invoice_type"]);

export function settlementsToCsv(records: SettlementRecord[]): string {
  const lines = [SETTLEMENT_CSV_COLUMNS.join(",")];
  for (const record of records) {
    lines.push(
      SETTLEMENT_CSV_COLUMNS.map((column) =>
        csvCell(record[column], TEXT_COLUMNS.has(column))
      ).join(",")
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export class InvestorSettlementHistoryService {
  constructor(private readonly dataSource: DataSource) {}

  async listSettlements(
    wallet: string,
    options: { limit: number; cursor?: string | null; filters: SettlementHistoryFilters }
  ): Promise<SettlementHistoryPage> {
    const after = options.cursor ? decodeSettlementCursor(options.cursor) : null;
    const rows = await this.query(wallet, options.filters, after, options.limit + 1);
    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map(computeSettlementRecord),
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeSettlementCursor({ settledAt: last.settled_at_exact, id: last.return_id })
          : null,
      limit: options.limit,
    };
  }

  /** Every matching settlement, newest first, for the CSV export. */
  async exportSettlements(
    wallet: string,
    filters: SettlementHistoryFilters
  ): Promise<SettlementRecord[]> {
    const rows = await this.query(wallet, filters, null, SETTLEMENT_EXPORT_MAX_ROWS + 1);
    if (rows.length > SETTLEMENT_EXPORT_MAX_ROWS) {
      throw new ServiceError(
        "EXPORT_TOO_LARGE",
        `More than ${SETTLEMENT_EXPORT_MAX_ROWS} settlements match; narrow the date range`,
        422
      );
    }
    return rows.map(computeSettlementRecord);
  }

  private query(
    wallet: string,
    filters: SettlementHistoryFilters,
    after: Cursor | null,
    limit: number
  ): Promise<SettlementRow[]> {
    // Newest first; (created_at, id) is a total order, so keyset pages
    // neither skip nor repeat rows. The cursor keeps microseconds for the
    // same reason as the invoice history cursor.
    return this.dataSource.query(
      `SELECT ir."id"                                  AS return_id,
              ir."invoice_id"                          AS invoice_id,
              inv."invoice_number"                     AS invoice_number,
              inv."category"                           AS invoice_type,
              to_char(ir."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                                                       AS settled_at_exact,
              i."investment_amount"::text              AS invested_amount,
              ir."return_amount"::text                 AS payout_amount,
              totals.total_invested::text              AS total_invested,
              sr."total_settlement_amount"::text       AS total_settlement_amount,
              sr."total_distributed_amount"::text      AS total_distributed_amount,
              sr."remainder_amount"::text              AS remainder_amount
       FROM "investor_returns" ir
       JOIN "users" u ON u."id" = ir."investor_id"
       JOIN "investments" i ON i."id" = ir."investment_id"
       JOIN "invoices" inv ON inv."id" = ir."invoice_id"
       CROSS JOIN LATERAL (
         SELECT COALESCE(SUM(i2."investment_amount"), 0) AS total_invested
         FROM "investor_returns" ir2
         JOIN "investments" i2 ON i2."id" = ir2."investment_id"
         WHERE ir2."invoice_id" = ir."invoice_id"
       ) totals
       LEFT JOIN LATERAL (
         SELECT s."total_settlement_amount", s."total_distributed_amount", s."remainder_amount"
         FROM "settlement_remainders" s
         WHERE s."invoice_id" = ir."invoice_id"
         ORDER BY s."created_at" DESC
         LIMIT 1
       ) sr ON true
       WHERE u."stellarAddress" = $1
         AND ($2::timestamptz IS NULL OR ir."created_at" >= $2::timestamptz)
         AND ($3::timestamptz IS NULL OR ir."created_at" <= $3::timestamptz)
         AND ($8::timestamptz IS NULL OR ir."created_at" < $8::timestamptz)
         AND ($4::text IS NULL OR lower(inv."category") = lower($4::text))
         AND ($5::timestamptz IS NULL OR (ir."created_at", ir."id") < ($5::timestamptz, $6::uuid))
       ORDER BY ir."created_at" DESC, ir."id" DESC
       LIMIT $7`,
      [
        wallet,
        filters.from ?? null,
        filters.to ?? null,
        filters.invoiceType ?? null,
        after?.settledAt ?? null,
        after?.id ?? null,
        limit,
        filters.before ?? null,
      ]
    );
  }
}

export function createInvestorSettlementHistoryService(
  dataSource: DataSource
): InvestorSettlementHistoryService {
  return new InvestorSettlementHistoryService(dataSource);
}
