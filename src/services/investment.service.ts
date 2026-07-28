import { DataSource, EntityManager } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { Decimal } from "decimal.js";
import { logInvoiceTransition } from "../lib/invoice-lifecycle-log";
import { logger } from "../observability/logger";
import { stroopsToXlm } from "../lib/stellar-format";

// Formula for expected return:
// Investor's share of the invoice face value (amount) proportional to their contribution to the fundable amount (netAmount).
// expectedReturn = investmentAmount * (invoice.amount / invoice.netAmount)
// This ensures the investor captures the discount.

export interface CreateInvestmentInput {
  invoiceId: string;
  investorId: string;
  investmentAmount: string;
  investorWallet: string;
}

export interface InvestorDashboard {
  totalInvested: string;
  totalReturns: string;
  activeInvestments: number;
  activeCount: number;
  activeTotal: string;
  settledCount: number;
  settledReturns: string;
  failedCount: number;
}

const ACTIVE_INVESTMENT_STATUSES = [InvestmentStatus.PENDING, InvestmentStatus.CONFIRMED];
const SETTLED_INVESTMENT_STATUSES = [InvestmentStatus.SETTLED];
const FAILED_INVESTMENT_STATUSES = [InvestmentStatus.CANCELLED];

export class InvestmentService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Aggregates an investor's portfolio across all their investments.
   *
   * - totalInvested sums investmentAmount across every status (a commitment
   *   counts once made, regardless of how it later resolves).
   * - totalReturns sums actualReturn for SETTLED investments only — pending
   *   or confirmed investments have no realised return yet.
   * - activeInvestments counts investments still in flight (PENDING/CONFIRMED).
   */
  async getInvestorDashboard(investorId: string): Promise<InvestorDashboard> {
    const investments = await this.dataSource.getRepository(Investment).find({
      where: { investorId },
    });

    let totalInvested = new Decimal(0);
    let totalReturns = new Decimal(0);
    let activeCount = 0;
    let activeTotal = new Decimal(0);
    let settledCount = 0;
    let failedCount = 0;

    for (const investment of investments) {
     const amount = new Decimal(investment.investmentAmount);
     totalInvested = totalInvested.plus(amount);

      if (ACTIVE_INVESTMENT_STATUSES.includes(investment.status)) {
       activeCount += 1;
       activeTotal = activeTotal.plus(amount);
     }

     if (SETTLED_INVESTMENT_STATUSES.includes(investment.status)) {
       settledCount += 1;
       if (investment.actualReturn !== null) {
         totalReturns = totalReturns.plus(new Decimal(investment.actualReturn));
       }
     }

     if (FAILED_INVESTMENT_STATUSES.includes(investment.status)) {
       failedCount += 1;
     }
    }

    return {
     totalInvested: totalInvested.toFixed(4),
     totalReturns: totalReturns.toFixed(4),
     activeInvestments: activeCount,
     activeCount,
     activeTotal: activeTotal.toFixed(4),
     settledCount,
     settledReturns: totalReturns.toFixed(4),
     failedCount,
    };
  }

  /**
   * Creates a new investment commitment for an invoice.
   * Uses a database transaction with a row-level lock on the invoice to prevent over-subscription.
   */
  async createInvestment(input: CreateInvestmentInput): Promise<Investment> {
    const { invoiceId, investorId, investmentAmount, investorWallet } = input;

    // Validate investment amount
    const amount = new Decimal(investmentAmount);
    if (amount.isNegative() || amount.isZero()) {
      throw new ServiceError("INVALID_AMOUNT", "Investment amount must be greater than zero");
    }

    return await this.dataSource.transaction(async (transactionalEntityManager: EntityManager) => {
      // 1. Lock the invoice row for update
      const invoice = await transactionalEntityManager
        .createQueryBuilder(Invoice, "invoice")
        .setLock("pessimistic_write")
        .where("invoice.id = :id", { id: invoiceId })
        .getOne();

      if (!invoice) {
        throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
      }

      // 2. Validate invoice status
      if (invoice.status !== InvoiceStatus.PUBLISHED) {
        throw new ServiceError(
          "INVALID_INVOICE_STATUS",
          `Cannot invest in an invoice with status ${invoice.status}`,
        );
      }

      // 3. Prevent self-dealing
      if (invoice.sellerId === investorId) {
        throw new ServiceError("SELF_DEALING", "Investors cannot invest in their own invoices");
      }

      // 4. Check remaining capacity
      // We count both PENDING and CONFIRMED investments towards the cap to prevent over-subscription
      const activeInvestments = await transactionalEntityManager.find(Investment, {
        where: [
          { invoiceId, status: InvestmentStatus.PENDING },
          { invoiceId, status: InvestmentStatus.CONFIRMED },
        ],
      });

      const totalInvested = activeInvestments.reduce(
        (sum, inv) => sum.plus(new Decimal(inv.investmentAmount)),
        new Decimal(0),
      );

      const netAmount = new Decimal(invoice.netAmount);
      const remainingCapacity = netAmount.minus(totalInvested);

      if (amount.gt(remainingCapacity)) {
        throw new ServiceError(
          "INSUFFICIENT_CAPACITY",
          `Investment amount ${amount.toString()} exceeds remaining capacity ${remainingCapacity.toString()}`,
        );
      }

      // 5. Calculate expected return
      // expectedReturn = investmentAmount * (invoice.amount / invoice.netAmount)
      const faceAmount = new Decimal(invoice.amount);
      const expectedReturn = amount.times(faceAmount.dividedBy(netAmount)).toDecimalPlaces(4);

      // 6. Create investment
      const investment = transactionalEntityManager.create(Investment, {
        invoiceId,
        investorId,
        investmentAmount: amount.toFixed(4),
        expectedReturn: expectedReturn.toFixed(4),
        status: InvestmentStatus.PENDING,
      });

      const savedInvestment = await transactionalEntityManager.save(Investment, investment);

      // 7. Emit structured log for the investment commitment
      const truncatedWallet =
        investorWallet.length >= 8
          ? `${investorWallet.slice(0, 4)}…${investorWallet.slice(-4)}`
          : investorWallet;
      const sharePercent = amount.dividedBy(netAmount).times(100).toFixed(2);

      logger.info("investment.committed", {
        investment_id: savedInvestment.id,
        invoice_id: invoiceId,
        investor_wallet: truncatedWallet,
        amount_xlm: stroopsToXlm(BigInt(amount.times(10_000_000).toFixed(0))),
        share_percent: sharePercent,
        committed_at: savedInvestment.createdAt?.toISOString() ?? new Date().toISOString(),
      });

      // 8. Transition invoice to FUNDED if fully subscribed
      const newTotalInvested = totalInvested.plus(amount);
      if (newTotalInvested.gte(netAmount)) {
        const previousStatus = invoice.status;
        invoice.status = InvoiceStatus.FUNDED;
        await transactionalEntityManager.save(Invoice, invoice);

        logInvoiceTransition(logger, {
          invoiceId: invoice.id,
          fromState: previousStatus,
          toState: InvoiceStatus.FUNDED,
          actorWallet: investorWallet,
          reason: "fully_funded",
        });
      }

      return savedInvestment;
    });
  }
}

export function createInvestmentService(dataSource: DataSource): InvestmentService {
  return new InvestmentService(dataSource);
}
