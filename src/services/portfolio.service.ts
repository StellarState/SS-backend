import { DataSource } from "typeorm";
import { Investment } from "../models/Investment.model";
import { InvestmentStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";

const ACTIVE_STATUSES = [InvestmentStatus.PENDING, InvestmentStatus.CONFIRMED];
const HISTORICAL_STATUSES = [InvestmentStatus.SETTLED, InvestmentStatus.CANCELLED];

export interface ActivePosition {
  investmentId: string;
  invoiceId: string;
  status: InvestmentStatus;
  principal: string;
  currentValue: string;
  createdAt: string;
}

export interface HistoricalPosition {
  investmentId: string;
  invoiceId: string;
  status: InvestmentStatus;
  principal: string;
  settlementAmount: string;
  netProfit: string;
  createdAt: string;
}

export interface PortfolioSummaryTotals {
  totalInvested: string;
  currentPortfolioValue: string;
  realisedReturns: string;
}

export interface PortfolioSummaryResult {
  active: ActivePosition[];
  historical: HistoricalPosition[];
  totals: PortfolioSummaryTotals;
  nextCursor: string | null;
}

export interface GetPortfolioOptions {
  investorId: string;
  cursor?: string;
  limit?: number;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const [iso, id] = Buffer.from(cursor, "base64").toString("utf8").split("|");
    return { createdAt: new Date(iso), id };
  } catch {
    throw new ServiceError("INVALID_CURSOR", "Invalid pagination cursor", 400);
  }
}

/** Investor portfolio summary: active + historical positions with P&L (#479). */
export class PortfolioService {
  constructor(private readonly dataSource: DataSource) {}

  async getPortfolioSummary(options: GetPortfolioOptions): Promise<PortfolioSummaryResult> {
    const { investorId } = options;
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

    const repo = this.dataSource.getRepository(Investment);

    let qb = repo
      .createQueryBuilder("investment")
      .where("investment.investorId = :investorId", { investorId })
      .orderBy("investment.created_at", "DESC")
      .addOrderBy("investment.id", "DESC")
      .take(limit + 1);

    if (options.cursor) {
      const { createdAt, id } = decodeCursor(options.cursor);
      qb = qb.andWhere(
        "(investment.created_at < :createdAt OR (investment.created_at = :createdAt AND investment.id < :id))",
        { createdAt, id },
      );
    }

    const page = await qb.getMany();
    const hasMore = page.length > limit;
    const pageItems = hasMore ? page.slice(0, limit) : page;

    const active: ActivePosition[] = [];
    const historical: HistoricalPosition[] = [];

    let totalInvested = 0;
    let currentPortfolioValue = 0;
    let realisedReturns = 0;

    // Totals aggregate the investor's FULL portfolio, not just this page —
    // computed from a separate unpaginated query so summary figures stay
    // correct regardless of which page the caller is viewing.
    const allInvestments = await repo.find({ where: { investorId } });

    for (const investment of allInvestments) {
      const principal = Number(investment.investmentAmount);
      totalInvested += principal;

      if (ACTIVE_STATUSES.includes(investment.status)) {
        currentPortfolioValue += principal;
      } else if (investment.status === InvestmentStatus.SETTLED) {
        const settlement = Number(investment.actualReturn ?? 0);
        realisedReturns += settlement - principal;
      } else if (investment.status === InvestmentStatus.CANCELLED) {
        // A rejected/cancelled invoice returns no principal — realised as a full loss.
        realisedReturns += -principal;
      }
    }

    for (const investment of pageItems) {
      if (ACTIVE_STATUSES.includes(investment.status)) {
        active.push({
          investmentId: investment.id,
          invoiceId: investment.invoiceId,
          status: investment.status,
          principal: investment.investmentAmount,
          currentValue: investment.investmentAmount,
          createdAt: investment.createdAt.toISOString(),
        });
      } else if (HISTORICAL_STATUSES.includes(investment.status)) {
        const principal = Number(investment.investmentAmount);
        const settlementAmount =
          investment.status === InvestmentStatus.SETTLED
            ? Number(investment.actualReturn ?? 0)
            : 0;
        const netProfit = settlementAmount - principal;

        historical.push({
          investmentId: investment.id,
          invoiceId: investment.invoiceId,
          status: investment.status,
          principal: investment.investmentAmount,
          settlementAmount: settlementAmount.toFixed(4),
          netProfit: netProfit.toFixed(4),
          createdAt: investment.createdAt.toISOString(),
        });
      }
    }

    const last = pageItems[pageItems.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

    return {
      active,
      historical,
      totals: {
        totalInvested: totalInvested.toFixed(4),
        currentPortfolioValue: currentPortfolioValue.toFixed(4),
        realisedReturns: realisedReturns.toFixed(4),
      },
      nextCursor,
    };
  }
}

export function createPortfolioService(dataSource: DataSource): PortfolioService {
  return new PortfolioService(dataSource);
}
