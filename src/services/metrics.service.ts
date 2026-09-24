import { DataSource } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../types/enums";

export interface DateRangeFilter {
  from?: Date;
  to?: Date;
}

export interface PlatformMetrics {
  invoiceCountsByStatus: Record<string, number>;
  totalFundedVolume: string;
  averageFundingTimeHours: number | null;
  activeInvestorCount: number;
  settlementSuccessRate: number;
  computedAt: string;
}

interface CacheEntry {
  key: string;
  value: PlatformMetrics;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;

/** Platform-wide metrics aggregation for the admin dashboard (#478). */
export class MetricsService {
  private cache: CacheEntry | null = null;

  constructor(private readonly dataSource: DataSource) {}

  private cacheKey(range: DateRangeFilter): string {
    return `${range.from?.toISOString() ?? ""}:${range.to?.toISOString() ?? ""}`;
  }

  async getPlatformMetrics(range: DateRangeFilter = {}): Promise<PlatformMetrics> {
    const key = this.cacheKey(range);
    const now = Date.now();

    if (this.cache && this.cache.key === key && this.cache.expiresAt > now) {
      return this.cache.value;
    }

    const metrics = await this.computeMetrics(range);
    this.cache = { key, value: metrics, expiresAt: now + CACHE_TTL_MS };
    return metrics;
  }

  private async computeMetrics(range: DateRangeFilter): Promise<PlatformMetrics> {
    const invoiceRepo = this.dataSource.getRepository(Invoice);
    const investmentRepo = this.dataSource.getRepository(Investment);

    let invoiceQb = invoiceRepo.createQueryBuilder("invoice");
    let investmentQb = investmentRepo.createQueryBuilder("investment");

    if (range.from) {
      invoiceQb = invoiceQb.andWhere("invoice.created_at >= :from", { from: range.from });
      investmentQb = investmentQb.andWhere("investment.created_at >= :from", { from: range.from });
    }
    if (range.to) {
      invoiceQb = invoiceQb.andWhere("invoice.created_at <= :to", { to: range.to });
      investmentQb = investmentQb.andWhere("investment.created_at <= :to", { to: range.to });
    }

    const invoices = await invoiceQb.getMany();
    const investments = await investmentQb.getMany();

    const invoiceCountsByStatus: Record<string, number> = {};
    for (const status of Object.values(InvoiceStatus)) {
      invoiceCountsByStatus[status] = 0;
    }

    let totalFundedVolume = 0;
    let fundingDurationSumHours = 0;
    let fundingDurationCount = 0;

    for (const invoice of invoices) {
      invoiceCountsByStatus[invoice.status] = (invoiceCountsByStatus[invoice.status] ?? 0) + 1;

      if (invoice.status === InvoiceStatus.FUNDED || invoice.status === InvoiceStatus.SETTLED) {
        totalFundedVolume += Number(invoice.amount);
        const hours = (invoice.updatedAt.getTime() - invoice.createdAt.getTime()) / 36e5;
        fundingDurationSumHours += hours;
        fundingDurationCount += 1;
      }
    }

    const activeInvestorIds = new Set(
      investments
        .filter((i) => i.status !== InvestmentStatus.CANCELLED)
        .map((i) => i.investorId),
    );

    const settledCount = invoices.filter((i) => i.status === InvoiceStatus.SETTLED).length;
    const fundedOrSettledCount = invoices.filter(
      (i) => i.status === InvoiceStatus.FUNDED || i.status === InvoiceStatus.SETTLED,
    ).length;

    return {
      invoiceCountsByStatus,
      totalFundedVolume: totalFundedVolume.toFixed(4),
      averageFundingTimeHours:
        fundingDurationCount > 0 ? fundingDurationSumHours / fundingDurationCount : null,
      activeInvestorCount: activeInvestorIds.size,
      settlementSuccessRate:
        fundedOrSettledCount > 0 ? (settledCount / fundedOrSettledCount) * 100 : 0,
      computedAt: new Date().toISOString(),
    };
  }
}

export function createMetricsService(dataSource: DataSource): MetricsService {
  return new MetricsService(dataSource);
}
