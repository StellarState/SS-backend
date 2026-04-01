import { DataSource, EntityManager } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { Decimal } from "decimal.js";

// Formula for expected return:
// Investor's share of the invoice face value (amount) proportional to their contribution to the fundable amount (netAmount).
// expectedReturn = investmentAmount * (invoice.amount / invoice.netAmount)
// This ensures the investor captures the discount.

export interface CreateInvestmentInput {
  invoiceId: string;
  investorId: string;
  investmentAmount: string;
}

export class InvestmentService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Creates a new investment commitment for an invoice.
   * Uses a database transaction with a row-level lock on the invoice to prevent over-subscription.
   */
  async createInvestment(input: CreateInvestmentInput): Promise<Investment> {
    const { invoiceId, investorId, investmentAmount } = input;

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

      // 7. Transition invoice to FUNDED if fully subscribed
      const newTotalInvested = totalInvested.plus(amount);
      if (newTotalInvested.gte(netAmount)) {
        invoice.status = InvoiceStatus.FUNDED;
        await transactionalEntityManager.save(Invoice, invoice);
      }

      return savedInvestment;
    });
  }
}

export function createInvestmentService(dataSource: DataSource): InvestmentService {
  return new InvestmentService(dataSource);
}
