import type { DataSource } from "typeorm";
import Decimal from "decimal.js";
import { User } from "../models/User.model";
import { InvoiceStatus, UserType } from "../types/enums";
import { decodeCursor, encodeCursor } from "../utils/cursor-pagination.utils";
import { formatPercentage } from "../utils/percentage.utils";
import { ServiceError } from "../utils/service-error";
import type { TransitionEffect } from "../lib/invoice-state-machine";
import { logger as defaultLogger, type AppLogger } from "../observability/logger";

export const ISSUER_SETTLEMENT_HISTORY_VIEW = "issuer_settlement_history_mv";
export const SPARKLINE_LENGTH = 10;
export const DEFAULT_INVOICE_HISTORY_LIMIT = 20;
export const MAX_INVOICE_HISTORY_LIMIT = 100;

/** Statuses that are visible on a public issuer profile. */
export const PUBLIC_INVOICE_STATUSES: readonly InvoiceStatus[] = [
  InvoiceStatus.PUBLISHED,
  InvoiceStatus.FUNDED,
  InvoiceStatus.SETTLED,
  InvoiceStatus.FAILED,
];

const ISSUER_USER_TYPES: readonly UserType[] = [UserType.SELLER, UserType.BOTH];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IssuerIdentity {
  wallet: string;
  display_name: string | null;
  user_type: UserType;
  kyc_verified: boolean;
  member_since: string;
}

export interface IssuerTrackRecord {
  settled_count: number;
  on_time_count: number;
  late_count: number;
  avg_days_to_settle: number | null;
  total_volume_usd: string;
}

export interface InvoiceYield {
  base_bps: number | null;
  adjustment_bps: number;
  effective_bps: number | null;
}

export interface IssuerInvoiceHistoryItem {
  id: string;
  invoice_number: string;
  title: string | null;
  amount: string;
  status: InvoiceStatus;
  yield: InvoiceYield;
  due_date: string;
  settlement_date: string | null;
  created_at: string;
}

export interface IssuerInvoiceHistoryPage {
  items: IssuerInvoiceHistoryItem[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface SparklinePoint {
  invoice_id: string;
  effective_bps: number;
  date: string;
}

export interface IssuerDynamicYield {
  current_rate_bps: number | null;
  current_rate_percent: number | null;
  sparkline: SparklinePoint[];
}

export interface IssuerProfile {
  identity: IssuerIdentity;
  track_record: IssuerTrackRecord;
  invoice_history: IssuerInvoiceHistoryPage;
  dynamic_yield: IssuerDynamicYield;
}

export interface IssuerProfileQuery {
  cursor?: string;
  limit?: number;
}

interface TrackRecordRow {
  settled_count: string | number | null;
  on_time_count: string | number | null;
  late_count: string | number | null;
  avg_days_to_settle: string | number | null;
  total_volume: string | number | null;
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  title: string | null;
  amount: string;
  status: InvoiceStatus;
  yield_bps: number | null;
  adjustment_bps: number | null;
  due_date: string | Date;
  settled_at: string | Date | null;
  created_at: string | Date;
}

function toIso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** `due_date` is selected as text so the pg driver cannot shift it into the server timezone. */
function toDateOnly(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return toIso(value).slice(0, 10);
}

function toInt(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number.parseInt(String(value), 10) || 0;
}

function effectiveYield(baseBps: number | null, adjustmentBps: number | null): InvoiceYield {
  const adjustment = adjustmentBps ?? 0;
  return {
    base_bps: baseBps,
    adjustment_bps: adjustment,
    effective_bps: baseBps === null ? null : baseBps + adjustment,
  };
}

/**
 * Latest on-chain yield adjustment per invoice. `yield_adjustments.invoice_id`
 * is a varchar populated from contract events, hence the text comparison.
 */
const LATEST_ADJUSTMENT_JOIN = `
  LEFT JOIN LATERAL (
    SELECT ya."adjustment_bps"
    FROM "yield_adjustments" ya
    WHERE ya."invoice_id" = i."id"::text
    ORDER BY ya."settled_at" DESC
    LIMIT 1
  ) adj ON true`;

/**
 * Aggregates the public issuer profile (issue #779): identity, settlement
 * track record (from the `issuer_settlement_history_mv` materialized view),
 * cursor-paginated invoice history and dynamic yield.
 */
export class IssuerProfileService {
  private refreshInFlight: Promise<void> | null = null;
  private refreshQueued = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly logger: AppLogger = defaultLogger
  ) {}

  async getProfile(wallet: string, query: IssuerProfileQuery = {}): Promise<IssuerProfile> {
    const limit = this.normaliseLimit(query.limit);
    const cursor = this.parseCursor(query.cursor);

    const user = await this.dataSource.getRepository(User).findOne({
      where: { stellarAddress: wallet },
    });
    if (!user) throw this.notFound(wallet);

    const isIssuerType = ISSUER_USER_TYPES.includes(user.userType);
    const [displayName, hasInvoices] = await Promise.all([
      this.getDisplayName(user.id),
      isIssuerType ? Promise.resolve(true) : this.hasInvoices(user.id),
    ]);
    if (!isIssuerType && !hasInvoices) throw this.notFound(wallet);

    const [trackRecord, invoiceHistory, dynamicYield] = await Promise.all([
      this.getTrackRecord(user.id),
      this.getInvoiceHistory(user.id, limit, cursor),
      this.getDynamicYield(user.id),
    ]);

    return {
      identity: {
        wallet: user.stellarAddress,
        display_name: displayName,
        user_type: user.userType,
        kyc_verified: Boolean(user.isKycVerified),
        member_since: toIso(user.createdAt),
      },
      track_record: trackRecord,
      invoice_history: invoiceHistory,
      dynamic_yield: dynamicYield,
    };
  }

  /**
   * Refreshes the settlement history view. Concurrent calls are coalesced:
   * while a refresh runs, further requests queue at most one follow-up refresh
   * so every settlement is reflected without stacking redundant refreshes.
   */
  async refreshSettlementHistory(): Promise<void> {
    // The view only exists on Postgres; the sqlite dev database has no
    // materialized views, so there is nothing to refresh.
    if (this.dataSource.options.type !== "postgres") return;
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return this.refreshInFlight;
    }

    this.refreshInFlight = (async () => {
      try {
        do {
          this.refreshQueued = false;
          await this.dataSource.query(
            `REFRESH MATERIALIZED VIEW CONCURRENTLY "${ISSUER_SETTLEMENT_HISTORY_VIEW}"`
          );
        } while (this.refreshQueued);
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }

  /** Invoice state machine effect: refresh the view when an invoice settles. */
  createSettlementRefreshEffect(): TransitionEffect {
    const refreshIssuerSettlementHistory: TransitionEffect = async (transition) => {
      if (transition.to !== InvoiceStatus.SETTLED) return;
      try {
        await this.refreshSettlementHistory();
      } catch (error) {
        this.logger.warn("Failed to refresh issuer settlement history view.", {
          invoice_id: transition.invoice.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    return refreshIssuerSettlementHistory;
  }

  private async getTrackRecord(sellerId: string): Promise<IssuerTrackRecord> {
    const rows: TrackRecordRow[] = await this.dataSource.query(
      `SELECT
         COUNT(*) AS settled_count,
         COUNT(*) FILTER (WHERE "settled_on_time") AS on_time_count,
         COUNT(*) FILTER (WHERE NOT "settled_on_time") AS late_count,
         AVG("days_to_settle") AS avg_days_to_settle,
         COALESCE(SUM("amount"), 0) AS total_volume
       FROM "${ISSUER_SETTLEMENT_HISTORY_VIEW}"
       WHERE "seller_id" = $1`,
      [sellerId]
    );
    const row = rows[0] ?? ({} as TrackRecordRow);
    const avg = row.avg_days_to_settle;

    return {
      settled_count: toInt(row.settled_count),
      on_time_count: toInt(row.on_time_count),
      late_count: toInt(row.late_count),
      avg_days_to_settle:
        avg === null || avg === undefined ? null : new Decimal(avg).toDecimalPlaces(2).toNumber(),
      total_volume_usd: new Decimal(row.total_volume ?? 0).toFixed(2),
    };
  }

  private async getInvoiceHistory(
    sellerId: string,
    limit: number,
    cursor: { createdAt: Date; id: string } | null
  ): Promise<IssuerInvoiceHistoryPage> {
    // Cursors carry millisecond timestamps while Postgres stores microseconds,
    // so order and compare on the truncated value to avoid skipping rows.
    const params: unknown[] = [sellerId, PUBLIC_INVOICE_STATUSES, limit + 1];
    let cursorClause = "";
    if (cursor) {
      params.push(cursor.createdAt.toISOString(), cursor.id);
      cursorClause = `AND (date_trunc('milliseconds', i."created_at"), i."id") < ($4::timestamptz, $5::uuid)`;
    }

    const rows: InvoiceRow[] = await this.dataSource.query(
      `SELECT
         i."id", i."invoice_number", i."title", i."amount", i."status",
         i."yield_bps", i."due_date"::text AS due_date, i."created_at",
         mv."settled_at", adj."adjustment_bps"
       FROM "invoices" i
       LEFT JOIN "${ISSUER_SETTLEMENT_HISTORY_VIEW}" mv ON mv."invoice_id" = i."id"
       ${LATEST_ADJUSTMENT_JOIN}
       WHERE i."seller_id" = $1
         AND i."deleted_at" IS NULL
         AND i."status"::text = ANY($2)
         ${cursorClause}
       ORDER BY date_trunc('milliseconds', i."created_at") DESC, i."id" DESC
       LIMIT $3`,
      params
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => ({
        id: row.id,
        invoice_number: row.invoice_number,
        title: row.title,
        amount: row.amount,
        status: row.status,
        yield: effectiveYield(row.yield_bps, row.adjustment_bps),
        due_date: toDateOnly(row.due_date),
        settlement_date: row.settled_at ? toIso(row.settled_at) : null,
        created_at: toIso(row.created_at),
      })),
      next_cursor: hasMore && last ? encodeCursor(new Date(last.created_at), last.id) : null,
      has_more: hasMore,
    };
  }

  /**
   * Current adjusted rate = the issuer's most recent invoice's base yield plus
   * its latest on-chain adjustment; the sparkline is the same figure for the
   * last {@link SPARKLINE_LENGTH} invoices, oldest first.
   */
  private async getDynamicYield(sellerId: string): Promise<IssuerDynamicYield> {
    const rows: InvoiceRow[] = await this.dataSource.query(
      `SELECT i."id", i."yield_bps", i."created_at", adj."adjustment_bps"
       FROM "invoices" i
       ${LATEST_ADJUSTMENT_JOIN}
       WHERE i."seller_id" = $1
         AND i."deleted_at" IS NULL
         AND i."yield_bps" IS NOT NULL
         AND i."status"::text = ANY($2)
       ORDER BY i."created_at" DESC, i."id" DESC
       LIMIT $3`,
      [sellerId, PUBLIC_INVOICE_STATUSES, SPARKLINE_LENGTH]
    );

    const sparkline: SparklinePoint[] = rows
      .map((row) => ({
        invoice_id: row.id,
        effective_bps: effectiveYield(row.yield_bps, row.adjustment_bps).effective_bps as number,
        date: toIso(row.created_at),
      }))
      .reverse();

    const current = sparkline.length > 0 ? sparkline[sparkline.length - 1].effective_bps : null;

    return {
      current_rate_bps: current,
      current_rate_percent:
        current === null ? null : Number(formatPercentage(new Decimal(current).dividedBy(100))),
      sparkline,
    };
  }

  private async getDisplayName(sellerId: string): Promise<string | null> {
    const rows: Array<{ issuer_name: string | null }> = await this.dataSource.query(
      `SELECT "issuer_name" FROM "invoices"
       WHERE "seller_id" = $1 AND "deleted_at" IS NULL AND "issuer_name" IS NOT NULL
       ORDER BY "created_at" DESC LIMIT 1`,
      [sellerId]
    );
    return rows[0]?.issuer_name ?? null;
  }

  private async hasInvoices(sellerId: string): Promise<boolean> {
    const rows: unknown[] = await this.dataSource.query(
      `SELECT 1 FROM "invoices" WHERE "seller_id" = $1 AND "deleted_at" IS NULL LIMIT 1`,
      [sellerId]
    );
    return rows.length > 0;
  }

  private normaliseLimit(limit: number | undefined): number {
    if (limit === undefined) return DEFAULT_INVOICE_HISTORY_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_INVOICE_HISTORY_LIMIT) {
      throw new ServiceError(
        "VALIDATION_ERROR",
        `limit must be an integer between 1 and ${MAX_INVOICE_HISTORY_LIMIT}.`,
        400
      );
    }
    return limit;
  }

  private parseCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
    if (!cursor) return null;
    let decoded: { createdAt: Date; id: string };
    try {
      decoded = decodeCursor(cursor);
    } catch {
      throw new ServiceError("INVALID_CURSOR", "cursor is invalid.", 400);
    }
    if (!UUID_PATTERN.test(decoded.id)) {
      throw new ServiceError("INVALID_CURSOR", "cursor is invalid.", 400);
    }
    return decoded;
  }

  private notFound(wallet: string): ServiceError {
    return new ServiceError(
      "ISSUER_NOT_FOUND",
      `No issuer record found for wallet ${wallet}.`,
      404
    );
  }
}

export function createIssuerProfileService(
  dataSource: DataSource,
  logger?: AppLogger
): IssuerProfileService {
  return new IssuerProfileService(dataSource, logger);
}
