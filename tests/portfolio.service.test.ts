import { DataSource } from "typeorm";
import { PortfolioService } from "../src/services/portfolio.service";
import { Investment } from "../src/models/Investment.model";
import { InvestmentStatus } from "../src/types/enums";

function makeInvestment(overrides: Partial<Investment> = {}): Investment {
  return {
    id: "invest-1",
    invoiceId: "invoice-1",
    investorId: "investor-1",
    investmentAmount: "100.0000",
    actualReturn: null,
    status: InvestmentStatus.CONFIRMED,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as Investment;
}

describe("PortfolioService", () => {
  let mockQb: any;
  let mockRepo: any;
  let mockDataSource: jest.Mocked<DataSource>;
  let service: PortfolioService;

  beforeEach(() => {
    mockQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };

    mockRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(mockQb),
      find: jest.fn().mockResolvedValue([]),
    };

    mockDataSource = {
      getRepository: jest.fn().mockReturnValue(mockRepo),
    } as any;

    service = new PortfolioService(mockDataSource);
  });

  it("classifies pending/confirmed investments as active positions", async () => {
    const investments = [
      makeInvestment({ status: InvestmentStatus.CONFIRMED, investmentAmount: "100.0000" }),
    ];
    mockQb.getMany.mockResolvedValue(investments);
    mockRepo.find.mockResolvedValue(investments);

    const result = await service.getPortfolioSummary({ investorId: "investor-1" });

    expect(result.active).toHaveLength(1);
    expect(result.active[0].currentValue).toBe("100.0000");
    expect(result.historical).toHaveLength(0);
  });

  it("computes positive net profit for a settled investment", async () => {
    const investments = [
      makeInvestment({
        status: InvestmentStatus.SETTLED,
        investmentAmount: "100.0000",
        actualReturn: "120.0000",
      }),
    ];
    mockQb.getMany.mockResolvedValue(investments);
    mockRepo.find.mockResolvedValue(investments);

    const result = await service.getPortfolioSummary({ investorId: "investor-1" });

    expect(result.historical[0].netProfit).toBe("20.0000");
    expect(result.totals.realisedReturns).toBe("20.0000");
  });

  it("represents a cancelled investment as a negative realised P&L", async () => {
    const investments = [
      makeInvestment({ status: InvestmentStatus.CANCELLED, investmentAmount: "100.0000" }),
    ];
    mockQb.getMany.mockResolvedValue(investments);
    mockRepo.find.mockResolvedValue(investments);

    const result = await service.getPortfolioSummary({ investorId: "investor-1" });

    expect(result.historical[0].netProfit).toBe("-100.0000");
    expect(result.totals.realisedReturns).toBe("-100.0000");
  });

  it("aggregates totals across all positions, not just the current page", async () => {
    const all = [
      makeInvestment({ id: "a", status: InvestmentStatus.CONFIRMED, investmentAmount: "100.0000" }),
      makeInvestment({ id: "b", status: InvestmentStatus.CONFIRMED, investmentAmount: "50.0000" }),
    ];
    mockQb.getMany.mockResolvedValue([all[0]]); // page only returns 1
    mockRepo.find.mockResolvedValue(all); // totals query returns both

    const result = await service.getPortfolioSummary({ investorId: "investor-1", limit: 1 });

    expect(result.totals.totalInvested).toBe("150.0000");
    expect(result.totals.currentPortfolioValue).toBe("150.0000");
  });

  it("returns a nextCursor when more results exist beyond the page limit", async () => {
    const page = [
      makeInvestment({ id: "a", createdAt: new Date("2026-01-02") }),
      makeInvestment({ id: "b", createdAt: new Date("2026-01-01") }),
    ];
    mockQb.getMany.mockResolvedValue(page); // limit + 1 returned
    mockRepo.find.mockResolvedValue(page);

    const result = await service.getPortfolioSummary({ investorId: "investor-1", limit: 1 });

    expect(result.nextCursor).not.toBeNull();
    expect(result.active).toHaveLength(1);
  });

  it("returns null nextCursor when all results fit within the page", async () => {
    mockQb.getMany.mockResolvedValue([makeInvestment()]);
    mockRepo.find.mockResolvedValue([makeInvestment()]);

    const result = await service.getPortfolioSummary({ investorId: "investor-1", limit: 20 });

    expect(result.nextCursor).toBeNull();
  });
});
