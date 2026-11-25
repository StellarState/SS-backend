import { DataSource } from "typeorm";
import { Decimal } from "decimal.js";
import { Investment } from "../models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";

export interface PortfolioPosition {
  investmentId: string;
  invoiceId: string;
  invoiceStatus: InvoiceStatus | null;
  status: InvestmentStatus;
  amountInvested: string;
  expectedReturn: string;
  currentValue: string;
  settlementAmount: string | null;
  realisedPnl: string | null;
  fundingDeadline: string | null;
  createdAt: string;
}

export interface PortfolioSummary {
  totalInvested: string;
  currentPortfolioValue: string;
  realisedReturns: string;
  realisedPnl: string;
}

export interface PortfolioPage {
  summary: PortfolioSummary;
  positions: PortfolioPosition[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface GetPortfolioOptions {
  cursor?: string | null;
  limit?: number;
  page?: number;
  offset?: number;
  status?: InvestmentStatus | InvestmentStatus[] | string;
  invoiceStatus?: InvoiceStatus | InvoiceStatus[] | string;
  startDate?: string | Date;
  endDate?: string | Date;
  minAmount?: string | number;
  maxAmount?: string | number;
  sortBy?: "createdAt" | "investmentAmount" | "amountInvested" | "expectedReturn" | "status" | string;
  sortOrder?: "ASC" | "DESC" | "asc" | "desc";
  order?: "ASC" | "DESC" | "asc" | "desc";
}

export interface DecodedPortfolioCursor {
  sortBy: string;
  sortOrder: "ASC" | "DESC";
  value: string;
  id: string;
}

export function encodeCursor(
  value: string | number | Date,
  id: string,
  sortBy: string = "createdAt",
  sortOrder: "ASC" | "DESC" = "DESC"
): string {
  if ((sortBy === "createdAt" || sortBy === "investment.createdAt") && sortOrder === "DESC") {
    const iso = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    return Buffer.from(`${iso}|${id}`).toString("base64");
  }
  const normalizedValue = value instanceof Date ? value.toISOString() : String(value);
  return Buffer.from(
    JSON.stringify({
      sortBy,
      sortOrder,
      value: normalizedValue,
      id,
    })
  ).toString("base64");
}

export function decodeCursor(cursor: string): DecodedPortfolioCursor {
  if (typeof cursor !== "string" || !cursor.trim()) {
    throw new ServiceError("INVALID_CURSOR", "Invalid portfolio cursor", 400);
  }

  let raw: string;
  try {
    raw = Buffer.from(cursor.trim(), "base64").toString("utf-8");
  } catch {
    throw new ServiceError("INVALID_CURSOR", "Invalid portfolio cursor", 400);
  }

  // Attempt JSON parsing (modern keyset cursor format)
  if (raw.startsWith("{") && raw.endsWith("}")) {
    try {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof parsed.id === "string" &&
        parsed.id.trim().length > 0 &&
        parsed.value !== undefined &&
        parsed.value !== null
      ) {
        const sortBy = typeof parsed.sortBy === "string" ? parsed.sortBy : "createdAt";
        const sortOrder =
          typeof parsed.sortOrder === "string" && parsed.sortOrder.toUpperCase() === "ASC"
            ? "ASC"
            : "DESC";
        return {
          sortBy,
          sortOrder,
          value: String(parsed.value),
          id: parsed.id.trim(),
        };
      }
    } catch {
      throw new ServiceError("INVALID_CURSOR", "Invalid portfolio cursor", 400);
    }
    throw new ServiceError("INVALID_CURSOR", "Invalid portfolio cursor", 400);
  }

  // Attempt legacy pipe-separated format (ISO_DATE|id)
  if (raw.includes("|")) {
    const parts = raw.split("|");
    if (parts.length !== 2) {
      throw new ServiceError("INVALID_CURSOR", "Invalid portfolio cursor", 400);
    }
    const [iso, id] = parts;
    const createdAt = new Date(iso);
    if (!id || !id.trim() || Number.isNaN(createdAt.getTime())) {
      throw new ServiceError("INVALID_CURSOR", "Invalid portfolio cursor", 400);
    }
    return {
      sortBy: "createdAt",
      sortOrder: "DESC",
      value: createdAt.toISOString(),
      id: id.trim(),
    };
  }

  throw new ServiceError("INVALID_CURSOR", "Invalid portfolio cursor", 400);
}

/**
 * Investor portfolio with active + historical positions and realised P&L.
 * Issue #479 — P&L = settlement amount − principal; negative for rejected/cancelled.
 */
export class PortfolioService {
  constructor(private readonly dataSource: DataSource) {}

  async getPortfolio(
    investorId: string,
    options: GetPortfolioOptions = {}
  ): Promise<PortfolioPage> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const repo = this.dataSource.getRepository(Investment);

    const qb = repo
      .createQueryBuilder("investment")
      .leftJoinAndSelect("investment.invoice", "invoice")
      .where("investment.investorId = :investorId", { investorId });

    // Status filtering
    if (options.status) {
      const statuses = Array.isArray(options.status)
        ? options.status
        : typeof options.status === "string"
        ? options.status.split(",").map((s) => s.trim())
        : [options.status];
      if (statuses.length === 1) {
        qb.andWhere("investment.status = :status", { status: statuses[0] });
      } else if (statuses.length > 1) {
        qb.andWhere("investment.status IN (:...statuses)", { statuses });
      }
    }

    // Invoice status filtering
    if (options.invoiceStatus) {
      const invoiceStatuses = Array.isArray(options.invoiceStatus)
        ? options.invoiceStatus
        : typeof options.invoiceStatus === "string"
        ? options.invoiceStatus.split(",").map((s) => s.trim())
        : [options.invoiceStatus];
      if (invoiceStatuses.length === 1) {
        qb.andWhere("invoice.status = :invoiceStatus", { invoiceStatus: invoiceStatuses[0] });
      } else if (invoiceStatuses.length > 1) {
        qb.andWhere("invoice.status IN (:...invoiceStatuses)", { invoiceStatuses });
      }
    }

    // Amount range filtering
    if (options.minAmount !== undefined && options.minAmount !== null) {
      const min = new Decimal(options.minAmount).toFixed(4);
      qb.andWhere("investment.investmentAmount >= :minAmount", { minAmount: min });
    }
    if (options.maxAmount !== undefined && options.maxAmount !== null) {
      const max = new Decimal(options.maxAmount).toFixed(4);
      qb.andWhere("investment.investmentAmount <= :maxAmount", { maxAmount: max });
    }

    // Date range filtering
    if (options.startDate) {
      const start = new Date(options.startDate);
      if (!Number.isNaN(start.getTime())) {
        qb.andWhere("investment.createdAt >= :startDate", { startDate: start });
      }
    }
    if (options.endDate) {
      const end = new Date(options.endDate);
      if (!Number.isNaN(end.getTime())) {
        qb.andWhere("investment.createdAt <= :endDate", { endDate: end });
      }
    }

    // Sorting column resolution
    const sortFieldMap: Record<string, string> = {
      createdAt: "investment.createdAt",
      "investment.createdAt": "investment.createdAt",
      amountInvested: "investment.investmentAmount",
      investmentAmount: "investment.investmentAmount",
      "investment.investmentAmount": "investment.investmentAmount",
      expectedReturn: "investment.expectedReturn",
      "investment.expectedReturn": "investment.expectedReturn",
      status: "investment.status",
      "investment.status": "investment.status",
      id: "investment.id",
      "investment.id": "investment.id",
    };

    const sortByParam = options.sortBy ?? "createdAt";
    const sortCol = sortFieldMap[sortByParam] ?? "investment.createdAt";
    const sortProp = (sortCol.replace("investment.", "") || "createdAt") as keyof Investment;

    const rawOrder = (options.sortOrder || options.order || "DESC").toUpperCase();
    const sortOrder: "ASC" | "DESC" = rawOrder === "ASC" ? "ASC" : "DESC";

    qb.orderBy(sortCol, sortOrder);
    qb.addOrderBy("investment.id", sortOrder);

    // Keyset cursor pagination
    if (options.cursor) {
      const decoded = decodeCursor(options.cursor);
      const cursorCol = sortFieldMap[decoded.sortBy] ?? sortCol;
      const orderToUse = decoded.sortOrder;

      const cursorVal = cursorCol.endsWith("createdAt")
        ? new Date(decoded.value)
        : decoded.value;

      if (orderToUse === "DESC") {
        qb.andWhere(
          `(${cursorCol} < :cursorVal OR (${cursorCol} = :cursorVal AND investment.id < :cursorId))`,
          { cursorVal, cursorId: decoded.id }
        );
      } else {
        qb.andWhere(
          `(${cursorCol} > :cursorVal OR (${cursorCol} = :cursorVal AND investment.id > :cursorId))`,
          { cursorVal, cursorId: decoded.id }
        );
      }
    } else if (
      (options.page !== undefined || options.offset !== undefined) &&
      "skip" in qb &&
      typeof (qb as { skip?: (n: number) => unknown }).skip === "function"
    ) {
      // Legacy offset-based pagination fallback
      const page = options.page ? Math.max(1, options.page) : 1;
      const skip = options.offset !== undefined ? Math.max(0, options.offset) : (page - 1) * limit;
      (qb as { skip: (n: number) => unknown }).skip(skip);
    }

    qb.take(limit + 1);

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    // Summary aggregates across the full portfolio (not just the page).
    const all = await repo.find({
      where: { investorId },
      relations: ["invoice"],
    });

    let totalInvested = new Decimal(0);
    let currentPortfolioValue = new Decimal(0);
    let realisedReturns = new Decimal(0);
    let realisedPnl = new Decimal(0);

    for (const inv of all) {
      const principal = new Decimal(inv.investmentAmount);
      totalInvested = totalInvested.plus(principal);

      if (
        inv.status === InvestmentStatus.PENDING ||
        inv.status === InvestmentStatus.CONFIRMED
      ) {
        // Active: mark-to-model as expected return (invoice funding state).
        currentPortfolioValue = currentPortfolioValue.plus(new Decimal(inv.expectedReturn));
      } else if (inv.status === InvestmentStatus.SETTLED) {
        const settlement = new Decimal(inv.actualReturn ?? inv.expectedReturn);
        realisedReturns = realisedReturns.plus(settlement);
        realisedPnl = realisedPnl.plus(settlement.minus(principal));
      } else if (inv.status === InvestmentStatus.CANCELLED) {
        // Rejected / cancelled: settlement is zero → negative P&L of principal.
        realisedPnl = realisedPnl.plus(new Decimal(0).minus(principal));
      }
    }

    const positions: PortfolioPosition[] = pageRows.map((inv) => {
      const principal = new Decimal(inv.investmentAmount);
      const invoiceStatus = inv.invoice?.status ?? null;
      const isActive =
        inv.status === InvestmentStatus.PENDING || inv.status === InvestmentStatus.CONFIRMED;
      const isSettled = inv.status === InvestmentStatus.SETTLED;
      const isCancelled = inv.status === InvestmentStatus.CANCELLED;

      let settlementAmount: string | null = null;
      let realised: string | null = null;
      let currentValue: string;

      if (isActive) {
        currentValue = new Decimal(inv.expectedReturn).toFixed(4);
      } else if (isSettled) {
        settlementAmount = new Decimal(inv.actualReturn ?? inv.expectedReturn).toFixed(4);
        realised = new Decimal(settlementAmount).minus(principal).toFixed(4);
        currentValue = "0.0000";
      } else if (isCancelled) {
        settlementAmount = "0.0000";
        realised = new Decimal(0).minus(principal).toFixed(4);
        currentValue = "0.0000";
      } else {
        currentValue = "0.0000";
      }

      return {
        investmentId: inv.id,
        invoiceId: inv.invoiceId,
        invoiceStatus,
        status: inv.status,
        amountInvested: principal.toFixed(4),
        expectedReturn: new Decimal(inv.expectedReturn).toFixed(4),
        currentValue,
        settlementAmount,
        realisedPnl: realised,
        fundingDeadline: inv.invoice?.fundingDeadline
          ? inv.invoice.fundingDeadline.toISOString()
          : null,
        createdAt: inv.createdAt.toISOString(),
      };
    });

    const last = pageRows[pageRows.length - 1];
    let nextCursor: string | null = null;
    if (hasMore && last) {
      const record = last as unknown as Record<string, string | number | Date | undefined>;
      const cursorRawVal = record[sortProp] ?? last.createdAt;
      nextCursor = encodeCursor(cursorRawVal, last.id, sortByParam, sortOrder);
    }

    return {
      summary: {
        totalInvested: totalInvested.toFixed(4),
        currentPortfolioValue: currentPortfolioValue.toFixed(4),
        realisedReturns: realisedReturns.toFixed(4),
        realisedPnl: realisedPnl.toFixed(4),
      },
      positions,
      nextCursor,
      hasMore,
    };
  }
}

export function createPortfolioService(dataSource: DataSource): PortfolioService {
  return new PortfolioService(dataSource);
}
