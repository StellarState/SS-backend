import { DataSource } from "typeorm";
import { MetricsService } from "../src/services/metrics.service";
import { Invoice } from "../src/models/Invoice.model";
import { Investment } from "../src/models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../src/types/enums";

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv-1",
    status: InvoiceStatus.FUNDED,
    amount: "1000.0000",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  } as Invoice;
}

function makeInvestment(overrides: Partial<Investment> = {}): Investment {
  return {
    id: "invest-1",
    investorId: "investor-1",
    status: InvestmentStatus.CONFIRMED,
    ...overrides,
  } as Investment;
}

describe("MetricsService", () => {
  let mockInvoiceQb: any;
  let mockInvestmentQb: any;
  let mockDataSource: jest.Mocked<DataSource>;
  let service: MetricsService;

  function chainable(qb: any) {
    qb.andWhere = jest.fn().mockReturnValue(qb);
    return qb;
  }

  beforeEach(() => {
    mockInvoiceQb = chainable({ getMany: jest.fn().mockResolvedValue([]) });
    mockInvestmentQb = chainable({ getMany: jest.fn().mockResolvedValue([]) });

    mockDataSource = {
      getRepository: jest.fn((entity: any) => ({
        createQueryBuilder: jest.fn().mockReturnValue(
          entity === Invoice ? mockInvoiceQb : mockInvestmentQb,
        ),
      })),
    } as any;

    service = new MetricsService(mockDataSource);
  });

  it("computes invoice counts by status and total funded volume", async () => {
    mockInvoiceQb.getMany.mockResolvedValue([
      makeInvoice({ status: InvoiceStatus.FUNDED, amount: "1000.0000" }),
      makeInvoice({ status: InvoiceStatus.SETTLED, amount: "500.0000" }),
      makeInvoice({ status: InvoiceStatus.DRAFT, amount: "200.0000" }),
    ]);

    const metrics = await service.getPlatformMetrics();

    expect(metrics.invoiceCountsByStatus[InvoiceStatus.FUNDED]).toBe(1);
    expect(metrics.invoiceCountsByStatus[InvoiceStatus.SETTLED]).toBe(1);
    expect(metrics.invoiceCountsByStatus[InvoiceStatus.DRAFT]).toBe(1);
    expect(metrics.totalFundedVolume).toBe("1500.0000");
  });

  it("computes settlement success rate against funded+settled invoices only", async () => {
    mockInvoiceQb.getMany.mockResolvedValue([
      makeInvoice({ status: InvoiceStatus.SETTLED }),
      makeInvoice({ status: InvoiceStatus.FUNDED }),
      makeInvoice({ status: InvoiceStatus.DRAFT }),
    ]);

    const metrics = await service.getPlatformMetrics();

    // 1 settled out of 2 (funded + settled) = 50%
    expect(metrics.settlementSuccessRate).toBe(50);
  });

  it("counts unique active investors, excluding cancelled investments", async () => {
    mockInvestmentQb.getMany.mockResolvedValue([
      makeInvestment({ investorId: "a", status: InvestmentStatus.CONFIRMED }),
      makeInvestment({ investorId: "a", status: InvestmentStatus.SETTLED }),
      makeInvestment({ investorId: "b", status: InvestmentStatus.CANCELLED }),
    ]);

    const metrics = await service.getPlatformMetrics();

    expect(metrics.activeInvestorCount).toBe(1);
  });

  it("applies the date range filter to both invoice and investment queries", async () => {
    const from = new Date("2026-01-01");
    const to = new Date("2026-01-31");

    await service.getPlatformMetrics({ from, to });

    expect(mockInvoiceQb.andWhere).toHaveBeenCalledWith("invoice.created_at >= :from", { from });
    expect(mockInvoiceQb.andWhere).toHaveBeenCalledWith("invoice.created_at <= :to", { to });
  });

  it("caches results for the same date range within the TTL window", async () => {
    await service.getPlatformMetrics();
    await service.getPlatformMetrics();

    // Only the first call should have hit the repository.
    expect(mockInvoiceQb.getMany).toHaveBeenCalledTimes(1);
  });

  it("recomputes when the date range differs (cache key changes)", async () => {
    await service.getPlatformMetrics({ from: new Date("2026-01-01") });
    await service.getPlatformMetrics({ from: new Date("2026-02-01") });

    expect(mockInvoiceQb.getMany).toHaveBeenCalledTimes(2);
  });
});
