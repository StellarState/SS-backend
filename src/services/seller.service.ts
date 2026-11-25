import { DataSource, In, Repository } from "typeorm";
import Decimal from "decimal.js";
import { Invoice } from "../models/Invoice.model";
import { SettlementRemainder } from "../models/SettlementRemainder.model";
import { InvoiceStatus } from "../types/enums";
import { percentageNumber } from "../utils/percentage.utils";

export interface SellerDashboardSummary {
  totalInvoices: number;
  totalFunded: number;
  totalSettled: number;
  totalRaised: string;
  /**
   * Gross repayment: sum of recorded settlement proceeds
   * (settlement_remainders.total_settlement_amount) for this seller's invoices.
   * Includes yield and any platform fee; never derived from funding targets.
   */
  totalRepaid: string;
  /**
   * Net investor distributions: sum of settlement_remainders.total_distributed_amount
   * (gross repayment minus fees, including the allocated rounding remainder).
   */
  totalDistributed: string;
}

export interface SellerDashboardInvoice {
  id: string;
  invoiceId: string;
  title: string;
  invoiceNumber: string;
  customerName: string;
  status: InvoiceStatus;
  amountRaised: string;
  fundedAmount: string;
  fundingTarget: string;
  fundingPercentage: number;
  fundingDeadline: Date;
  dueDate: Date;
  createdAt: Date;
}

export interface SellerDashboardData {
  totalInvoices: number;
  totalFunded: number;
  totalSettled: number;
  totalRaised: string;
  totalRepaid: string;
  totalDistributed: string;
  summary: SellerDashboardSummary;
  invoices: SellerDashboardInvoice[];
}

export class SellerService {
  constructor(
    private readonly invoiceRepository: Repository<Invoice>,
    private readonly settlementRemainderRepository: Repository<SettlementRemainder>
  ) {}

  async getDashboard(sellerId: string): Promise<SellerDashboardData> {
    const invoices = await this.invoiceRepository.find({
      where: { sellerId },
      order: { createdAt: "DESC" },
    });

    let totalFunded = 0;
    let totalSettled = 0;
    let totalRaisedDec = new Decimal(0);
    let totalRepaidDec = new Decimal(0);
    let totalDistributedDec = new Decimal(0);

    // Repayment comes only from persisted settlement records. Invoices marked
    // settled without a record contribute nothing (no fabricated values).
    const invoiceIds = invoices.map((inv) => inv.id);
    const settlementRecords =
      invoiceIds.length > 0
        ? await this.settlementRemainderRepository.find({
            where: { invoiceId: In(invoiceIds) },
          })
        : [];
    for (const record of settlementRecords) {
      totalRepaidDec = totalRepaidDec.plus(new Decimal(record.totalSettlementAmount || "0"));
      totalDistributedDec = totalDistributedDec.plus(
        new Decimal(record.totalDistributedAmount || "0")
      );
    }

    const formattedInvoices: SellerDashboardInvoice[] = invoices.map((inv) => {
      if (inv.status === InvoiceStatus.FUNDED) {
        totalFunded++;
      } else if (inv.status === InvoiceStatus.SETTLED) {
        totalSettled++;
      }

      const raised = new Decimal(inv.fundedAmount || "0");
      totalRaisedDec = totalRaisedDec.plus(raised);

      const targetDec = new Decimal(inv.netAmount || inv.amount || "0");
      const percentage = percentageNumber(raised, targetDec, { maximum: 100 });

      return {
        id: inv.id,
        invoiceId: inv.id,
        title: `${inv.invoiceNumber} - ${inv.customerName}`,
        invoiceNumber: inv.invoiceNumber,
        customerName: inv.customerName,
        status: inv.status,
        amountRaised: inv.fundedAmount || "0",
        fundedAmount: inv.fundedAmount || "0",
        fundingTarget: inv.netAmount || inv.amount,
        fundingPercentage: percentage,
        // Fall back to dueDate only for legacy rows where fundingDeadline is null.
        fundingDeadline: inv.fundingDeadline ?? inv.dueDate,
        dueDate: inv.dueDate,
        createdAt: inv.createdAt,
      };
    });

    const summary: SellerDashboardSummary = {
      totalInvoices: invoices.length,
      totalFunded,
      totalSettled,
      totalRaised: totalRaisedDec.toFixed(4),
      totalRepaid: totalRepaidDec.toFixed(4),
      totalDistributed: totalDistributedDec.toFixed(4),
    };

    return {
      ...summary,
      summary,
      invoices: formattedInvoices,
    };
  }
}

export function createSellerService(dataSource: DataSource): SellerService {
  return new SellerService(
    dataSource.getRepository(Invoice),
    dataSource.getRepository(SettlementRemainder)
  );
}
