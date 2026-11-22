import { DataSource, EntityManager } from "typeorm";
import { Decimal } from "decimal.js";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import {
  recordSettlementCompleted,
  recordSettlementFailed,
  recordSettlementStarted,
} from "../lib/settlement-metrics";

export interface SettleInvoiceInput {
  invoiceId: string;
  proceeds: string;
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

export interface SettlementHistoryRecord {
  invoice_id: string;
  settled_at: Date;
  fractions_held: string;
  principal_returned: string;
  yield_earned: string;
  fees: string;
  net_return_usd: string;
  net_return_pct: string;
}

export interface SettlementHistoryPage {
  settlements: SettlementHistoryRecord[];
  next_cursor: string | null;
}

export interface SettlementHistoryOptions {
  fromDate?: Date;
  toDate?: Date;
  invoiceType?: string;
  cursor?: string;
  limit?: number;
}

export class SettlementService {
  constructor(
    private readonly dataSource: DataSource,
    /** Notified with the invoice's `sellerId` once it settles, so cached issuer analytics can be invalidated (issue #587). */
    private readonly onInvoiceChanged?: (sellerId: string) => void,
  ) {}

  async getSettlementHistory(wallet: string, options: SettlementHistoryOptions = {}): Promise<SettlementHistoryPage> {
    const investments = await this.dataSource.getRepository(Investment).find({
      where: { status: InvestmentStatus.SETTLED },
      relations: { invoice: true, investor: true },
    });
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
    const offset = decodeCursor(options.cursor);
    const records = investments
      .filter((investment) => investment.investor?.stellarAddress === wallet)
      .filter((investment) => investment.actualReturn !== null && investment.invoice)
      .filter((investment) => !options.invoiceType || investment.invoice.category === options.invoiceType)
      .map((investment) => this.toSettlementHistoryRecord(investment))
      .filter((record) => !options.fromDate || record.settled_at >= options.fromDate)
      .filter((record) => !options.toDate || record.settled_at <= options.toDate)
      .sort((a, b) => b.settled_at.getTime() - a.settled_at.getTime() || b.invoice_id.localeCompare(a.invoice_id));
    const page = records.slice(offset, offset + limit);
    return { settlements: page, next_cursor: offset + limit < records.length ? encodeCursor(offset + limit) : null };
  }

  private toSettlementHistoryRecord(investment: Investment): SettlementHistoryRecord {
    const principal = new Decimal(investment.investmentAmount);
    const netReturn = new Decimal(investment.actualReturn ?? 0);
    const invoice = investment.invoice;
    return {
      invoice_id: invoice.id,
      settled_at: new Date(invoice.updatedAt),
      fractions_held: principal.dividedBy(invoice.amount).toDecimalPlaces(8).toFixed(8),
      principal_returned: principal.toFixed(4),
      yield_earned: netReturn.minus(principal).toFixed(4),
      fees: "0.0000",
      net_return_usd: netReturn.toFixed(4),
      net_return_pct: (principal.isZero() ? new Decimal(0) : netReturn.dividedBy(principal).times(100)).toFixed(4),
    };
  }

  /**
   * Settles a funded invoice by distributing proceeds to each investor
   * pro-rata to their share of the invoice's face value.
   */
  async settleInvoice(input: SettleInvoiceInput): Promise<SettleInvoiceResult> {
    const { invoiceId, proceeds: proceedsInput } = input;

    const proceeds = new Decimal(proceedsInput);
    if (proceeds.isNegative() || proceeds.isZero()) {
      throw new ServiceError(
        "INVALID_PROCEEDS",
        "Settlement proceeds must be greater than zero",
      );
    }

    recordSettlementStarted();
    try {
      const result = await this.dataSource.transaction(async (transactionalEntityManager: EntityManager) => {
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
      if (invoice.status !== InvoiceStatus.FUNDED) {
        throw new ServiceError(
          "INVALID_INVOICE_STATUS",
          `Cannot settle an invoice with status ${invoice.status}`,
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

      // 4. Distribute proceeds pro-rata to each investor's share of the face value
      const faceValue = new Decimal(invoice.amount);
      const settlements: InvestorSettlement[] = [];

      for (const investment of investments) {
        const investmentAmount = new Decimal(investment.investmentAmount);
        const actualReturn = investmentAmount
          .times(proceeds)
          .dividedBy(faceValue)
          .toDecimalPlaces(4);

        investment.actualReturn = actualReturn.toFixed(4);
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
      invoice.status = InvoiceStatus.SETTLED;
      await transactionalEntityManager.save(Invoice, invoice);
      this.onInvoiceChanged?.(invoice.sellerId);

      return {
        invoiceId: invoice.id,
        status: InvoiceStatus.SETTLED as const,
        proceeds: proceeds.toFixed(4),
        settlements,
      };
    });
      recordSettlementCompleted();
      return result;
    } catch (error) {
      recordSettlementFailed();
      throw error;
    }
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  const offset = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
  return Number.isInteger(offset) && offset >= 0 ? offset : 0;
}

export function createSettlementService(
  dataSource: DataSource,
  onInvoiceChanged?: (sellerId: string) => void,
): SettlementService {
  return new SettlementService(dataSource, onInvoiceChanged);
}
