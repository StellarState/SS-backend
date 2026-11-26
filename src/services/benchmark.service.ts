import { DataSource } from "typeorm";
import { SectorBenchmark } from "../models/SectorBenchmark.model";
import { Invoice } from "../models/Invoice.model";
import { InvoiceStatusHistory } from "../models/InvoiceStatusHistory.model";
import { InvoiceStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { TtlCache } from "../lib/ttl-cache";

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_TTL_SECONDS = CACHE_TTL_MS / 1000;
const MS_PER_DAY = 86_400_000;

export interface BenchmarkUpdatedEvent {
  sector: string;
  avgYield: string;
  avgDaysToSettle: string;
  defaultRate: string;
  sampleCount?: number;
  eventId?: string;
  occurredAt?: Date;
}

export interface SectorBenchmarkView {
  sector: string;
  avgYield: string;
  /** Realized settlement duration in days, not scheduled invoice tenor. */
  avgDaysToSettle: string;
  defaultRate: string;
  sampleCount: number;
  updatedAt: string;
}

/**
 * Invoice-side metrics compared against a sector benchmark (issue #778).
 *
 * `scheduledTenorDays` is contractual (due date minus creation) and says
 * nothing about when the invoice actually settled. `realizedSettlementDays`
 * is observed: creation to the recorded settlement transition, only available
 * once the invoice has settled. Both are rounded whole days, matching the
 * sector benchmark's `avgDaysToSettle`.
 *
 * `daysToSettle` is kept as a deprecated alias of `realizedSettlementDays` so
 * existing clients keep a correctly-based value instead of a scheduled tenor
 * masquerading as realized performance.
 */
export interface InvoiceBenchmarkMetrics {
  yield: string;
  /** Contractual due date minus creation date, in days; null if invalid. */
  scheduledTenorDays: number | null;
  /** Creation to actual settlement, in days; null while unsettled or invalid. */
  realizedSettlementDays: number | null;
  /** @deprecated Use `realizedSettlementDays`. */
  daysToSettle: number | null;
  /** Authoritative settlement timestamp, ISO-8601; null while unsettled. */
  settledAt: string | null;
  amount: string;
  status: string;
}

export interface InvoiceBenchmarkComparison {
  invoiceId: string;
  sector: string | null;
  invoice: InvoiceBenchmarkMetrics;
  benchmark: SectorBenchmarkView | null;
}

/**
 * Sector benchmark aggregates (#676). `ingestBenchmarkUpdated` is the
 * indexer entry point for BenchmarkUpdated contract events; reads go
 * through a 5-minute TTL cache that is invalidated per sector on write.
 */
export class BenchmarkService {
  private readonly cache = new TtlCache({ ttlSeconds: CACHE_TTL_SECONDS, namespace: "benchmark" });
  private readonly comparisonCache = new TtlCache({
    ttlSeconds: CACHE_TTL_SECONDS,
    namespace: "benchmark-comparison",
  });

  constructor(private readonly dataSource: DataSource) {}

  /** Indexer: upsert sector averages from a BenchmarkUpdated event. */
  async ingestBenchmarkUpdated(event: BenchmarkUpdatedEvent): Promise<SectorBenchmark> {
    const sector = event.sector.trim().toLowerCase();
    if (!sector) {
      throw new ServiceError("INVALID_SECTOR", "sector is required", 400);
    }

    const repo = this.dataSource.getRepository(SectorBenchmark);
    let row = await repo.findOneBy({ sector });
    if (!row) {
      row = repo.create({ sector });
    }

    row.avgYield = event.avgYield;
    row.avgDaysToSettle = event.avgDaysToSettle;
    row.defaultRate = event.defaultRate;
    if (event.sampleCount !== undefined) row.sampleCount = event.sampleCount;
    if (event.eventId) row.lastEventId = event.eventId;

    const saved = await repo.save(row);

    this.cache.invalidatePrefix(sector);
    this.comparisonCache.clear();
    return saved;
  }

  async getSectorBenchmark(sector: string): Promise<SectorBenchmarkView> {
    const normalized = sector.trim().toLowerCase();
    const cached = await this.cache.get<SectorBenchmarkView>(normalized);
    if (cached) return cached;

    const row = await this.dataSource.getRepository(SectorBenchmark).findOneBy({
      sector: normalized,
    });
    if (!row) {
      throw new ServiceError(
        "BENCHMARK_NOT_FOUND",
        `No benchmark data for sector "${normalized}"`,
        404,
      );
    }

    const view = toView(row);
    await this.cache.set(normalized, view);
    return view;
  }

  /** Invoice metrics side-by-side with its sector benchmark (#676). */
  async getInvoiceBenchmark(invoiceId: string): Promise<InvoiceBenchmarkComparison> {
    const cached = await this.comparisonCache.get<InvoiceBenchmarkComparison>(invoiceId);
    if (cached) return cached;

    const invoice = await this.dataSource.getRepository(Invoice).findOneBy({ id: invoiceId });
    if (!invoice) {
      throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
    }

    let benchmark: SectorBenchmarkView | null = null;
    if (invoice.category) {
      try {
        benchmark = await this.getSectorBenchmark(invoice.category);
      } catch (err) {
        if ((err as ServiceError).code !== "BENCHMARK_NOT_FOUND") throw err;
      }
    }

    const settledAt = await this.findSettlementTime(invoice);
    const realized = realizedSettlementDays(invoice, settledAt);
    const comparison: InvoiceBenchmarkComparison = {
      invoiceId: invoice.id,
      sector: invoice.category,
      invoice: {
        yield: invoice.discountRate,
        scheduledTenorDays: scheduledTenorDays(invoice),
        realizedSettlementDays: realized,
        daysToSettle: realized,
        settledAt: settledAt ? settledAt.toISOString() : null,
        amount: invoice.amount,
        status: invoice.status,
      },
      benchmark,
    };

    await this.comparisonCache.set(invoiceId, comparison);
    return comparison;
  }

  invalidateSector(sector: string): void {
    this.cache.invalidatePrefix(sector.trim().toLowerCase());
    this.comparisonCache.clear();
  }

  /**
   * Settlement time from the append-only status history, which is written in
   * the same transaction as the status change. Invoices that are not settled,
   * or that predate history recording, have no realized duration.
   */
  private async findSettlementTime(invoice: Invoice): Promise<Date | null> {
    if (invoice.status !== InvoiceStatus.SETTLED) return null;

    const history = await this.dataSource.getRepository(InvoiceStatusHistory).findOne({
      where: { invoiceId: invoice.id, toStatus: InvoiceStatus.SETTLED },
      order: { createdAt: "ASC" },
    });
    if (!history) return null;

    const settledAt = asValidDate(history.createdAt);
    return settledAt;
  }
}

function toView(row: SectorBenchmark): SectorBenchmarkView {
  return {
    sector: row.sector,
    avgYield: row.avgYield,
    avgDaysToSettle: row.avgDaysToSettle,
    defaultRate: row.defaultRate,
    sampleCount: row.sampleCount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Contractual duration from creation to due date, in whole days. */
export function scheduledTenorDays(
  invoice: Pick<Invoice, "createdAt" | "dueDate">
): number | null {
  const created = asValidDate(invoice.createdAt);
  const due = asValidDate(invoice.dueDate);
  if (!created || !due) return null;
  return wholeDaysBetween(created, due);
}

/**
 * Actual duration from creation to the recorded settlement moment, in whole
 * days. Returns null when the invoice has not settled or either timestamp is
 * invalid; invalid input never becomes a zero-day observation.
 */
export function realizedSettlementDays(
  invoice: Pick<Invoice, "createdAt">,
  settledAt: Date | null
): number | null {
  const created = asValidDate(invoice.createdAt);
  if (!created || !settledAt) return null;
  return wholeDaysBetween(created, settledAt);
}

function wholeDaysBetween(start: Date, end: Date): number | null {
  const days = (end.getTime() - start.getTime()) / MS_PER_DAY;
  if (!Number.isFinite(days) || days < 0) return null;
  return Math.round(days);
}

function asValidDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

export function createBenchmarkService(dataSource: DataSource): BenchmarkService {
  return new BenchmarkService(dataSource);
}
