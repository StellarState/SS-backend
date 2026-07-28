import { DataSource, EntityManager } from "typeorm";
import { Decimal } from "decimal.js";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { computeInvestorReturn } from "../lib/investor-return";
import { decimalStringToScaledBigInt, scaledBigIntToDecimalString } from "../lib/decimal-bigint";
import { logInvoiceTransition } from "../lib/invoice-lifecycle-log";
import { logger } from "../observability/logger";

export interface SettleInvoiceInput {
  invoiceId: string;
  proceeds: string;
  actorWallet: string;
}

export interface InvestorSettlement {
  investmentId: string;
  investorId: string;
  investmentAmount: string;
  actualReturn: string;
}

export interface SettleInvoiceResult {
  invoiceId: string;
  status: InvoiceStatus.SETTLED;
  proceeds: string;
  settlements: InvestorSettlement[];
}

export class SettlementService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Settles a funded invoice by distributing proceeds to each investor
   * pro-rata to their share of the invoice's face value.
   */
  async settleInvoice(input: SettleInvoiceInput): Promise<SettleInvoiceResult> {
    const { invoiceId, proceeds: proceedsInput, actorWallet } = input;

    const proceeds = new Decimal(proceedsInput);
    if (proceeds.isNegative() || proceeds.isZero()) {
      throw new ServiceError(
        "INVALID_PROCEEDS",
        "Settlement proceeds must be greater than zero",
      );
    }

    return await this.dataSource.transaction(async (transactionalEntityManager: EntityManager) => {
      // 1. Lock the invoice row for update (if supported by the driver).
      //    SQLite does not support row-level locking, so we fall back to a plain read.
      let invoice: Invoice | null;
      try {
        invoice = await transactionalEntityManager
          .createQueryBuilder(Invoice, "invoice")
          .setLock("pessimistic_write")
          .where("invoice.id = :id", { id: invoiceId })
          .getOne();
      } catch {
        invoice = await transactionalEntityManager
          .createQueryBuilder(Invoice, "invoice")
          .where("invoice.id = :id", { id: invoiceId })
          .getOne();
      }

      if (!invoice) {
        throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
      }

      // 2. Validate invoice status
      if (invoice.status !== InvoiceStatus.FUNDED) {
        throw new ServiceError(
          "INVALID_INVOICE_STATUS",
          `INVALID_INVOICE_STATUS: Cannot settle an invoice with status ${invoice.status}`,
        );
      }

      // 3. Find confirmed investments backing this invoice
      const investments = await transactionalEntityManager.find(Investment, {
        where: { invoiceId: invoice.id, status: InvestmentStatus.CONFIRMED },
      });

      if (investments.length === 0) {
        throw new ServiceError(
          "NO_CONFIRMED_INVESTMENTS",
          "Invoice has no confirmed investments to settle",
        );
      }

      // 4. Distribute proceeds pro-rata to each investor's share of the total funded amount
      const totalFunded = investments.reduce(
        (sum, investment) => sum.plus(new Decimal(investment.investmentAmount)),
        new Decimal(0),
      );
      const totalFundedScaled = decimalStringToScaledBigInt(totalFunded.toFixed(4));
      const proceedsScaled = decimalStringToScaledBigInt(proceeds.toFixed(4));
      const settlements: InvestorSettlement[] = [];

      for (const investment of investments) {
        const investmentAmountScaled = decimalStringToScaledBigInt(investment.investmentAmount);
        const actualReturnScaled = computeInvestorReturn(
          investmentAmountScaled,
          totalFundedScaled,
          proceedsScaled,
        );

        investment.actualReturn = scaledBigIntToDecimalString(actualReturnScaled);
        investment.status = InvestmentStatus.SETTLED;
        await transactionalEntityManager.save(Investment, investment);

        settlements.push({
          investmentId: investment.id,
          investorId: investment.investorId,
          investmentAmount: investment.investmentAmount,
          actualReturn: investment.actualReturn,
        });
      }

      // 5. Transition invoice to SETTLED
      const previousStatus = invoice.status;
      invoice.status = InvoiceStatus.SETTLED;
      await transactionalEntityManager.save(Invoice, invoice);

      logInvoiceTransition(logger, {
        invoiceId: invoice.id,
        fromState: previousStatus,
        toState: InvoiceStatus.SETTLED,
        actorWallet,
        reason: "admin_settled",
      });

      return {
        invoiceId: invoice.id,
        status: InvoiceStatus.SETTLED as const,
        proceeds: proceeds.toFixed(4),
        settlements,
      };
    });
  }
}

export function createSettlementService(dataSource: DataSource): SettlementService {
  return new SettlementService(dataSource);
}
