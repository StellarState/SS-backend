import { DataSource } from "typeorm";
import { Decimal } from "decimal.js";
import { Investment } from "../models/Investment.model";
import { InvestorReturn } from "../models/InvestorReturn.model";
import { InvoiceStatus, InvestmentStatus } from "../types/enums";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginateQuery,
  type CursorPagination,
} from "../middleware/cursor-pagination.middleware";

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
  /** Present only when another page exists (issue #559). */
  nextCursor?: string;
  hasMore: boolean;
}

export interface PayoutRecord {
  id: string;
  invoiceId: string;
  investmentId: string;
  /** Amount paid out to the investor at settlement. */
  amount: string;
  returnAmount: string;
  paidAt: string;
}

export interface PayoutPage {
  payouts: PayoutRecord[];
  nextCursor?: string;
  hasMore: boolean;
}

/** Fills in defaults for callers that page without the middleware. */
function normalizePagination(
  scope: string,
  pagination: Partial<CursorPagination> = {}
): CursorPagination {
  return {
    scope,
    limit: Math.min(Math.max(pagination.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE),
    sort: pagination.sort ?? "created_at",
    order: pagination.order ?? "DESC",
    after: pagination.after ?? null,
  };
}

/**
 * Investor portfolio with active + historical positions and realised P&L.
 * Issue #479 — P&L = settlement amount − principal; negative for rejected/cancelled.
 */
export class PortfolioService {
  constructor(private readonly dataSource: DataSource) {}

  async getPortfolio(
    investorId: string,
    options: Partial<CursorPagination> = {}
  ): Promise<PortfolioPage> {
    const repo = this.dataSource.getRepository(Investment);

    const qb = repo
      .createQueryBuilder("investment")
      .leftJoinAndSelect("investment.invoice", "invoice")
      .where("investment.investorId = :investorId", { investorId });

    const page = await paginateQuery(qb, normalizePagination("portfolio", options), {
      sortColumn: "investment.createdAt",
      idColumn: "investment.id",
      position: (investment) => ({ value: investment.createdAt, id: investment.id }),
    });
    const pageRows = page.items;

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

    return {
      summary: {
        totalInvested: totalInvested.toFixed(4),
        currentPortfolioValue: currentPortfolioValue.toFixed(4),
        realisedReturns: realisedReturns.toFixed(4),
        realisedPnl: realisedPnl.toFixed(4),
      },
      positions,
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  /**
   * Settlement payouts received by the investor, newest first (issue #559).
   * One row per investment paid out when its invoice settled.
   */
  async getPayoutHistory(
    investorId: string,
    options: Partial<CursorPagination> = {}
  ): Promise<PayoutPage> {
    const qb = this.dataSource
      .getRepository(InvestorReturn)
      .createQueryBuilder("payout")
      .where("payout.investorId = :investorId", { investorId });

    const page = await paginateQuery(qb, normalizePagination("payouts", options), {
      sortColumn: "payout.createdAt",
      idColumn: "payout.id",
      position: (payout) => ({ value: payout.createdAt, id: payout.id }),
    });

    return {
      payouts: page.items.map((payout) => ({
        id: payout.id,
        invoiceId: payout.invoiceId,
        investmentId: payout.investmentId,
        amount: new Decimal(payout.amount).toFixed(4),
        returnAmount: new Decimal(payout.returnAmount).toFixed(4),
        paidAt: new Date(payout.createdAt).toISOString(),
      })),
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
}

export function createPortfolioService(dataSource: DataSource): PortfolioService {
  return new PortfolioService(dataSource);
}
