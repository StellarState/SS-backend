import { DataSource, EntityManager, OptimisticLockVersionMismatchError } from "typeorm";
import { InvestmentService } from "../../../src/services/investment.service";
import { Invoice } from "../../../src/models/Invoice.model";
import { Investment } from "../../../src/models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../../../src/types/enums";
import { Decimal } from "decimal.js";

const INVESTOR_WALLET = "GINVESTORWALLET1234567890ABCDEFGHIJKLMNOPQRSTUV";

function createMockQueryBuilder(getOneResult: Invoice) {
  const builder = {
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(getOneResult),
  };
  return builder;
}

function createMockEntityManager(
  saveResults: Array<unknown>,
  shouldThrowOptimisticLock = false,
) {
  let saveCallCount = 0;
  const manager = {
    createQueryBuilder: jest.fn().mockReturnValue(createMockQueryBuilder({
      id: "invoice-1",
      sellerId: "seller-1",
      amount: "1000.0000",
      netAmount: "1000.0000",
      status: InvoiceStatus.PUBLISHED,
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    } as Invoice)),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((entity: any, data: any) => data),
    save: jest.fn().mockImplementation(async (entity: any, data: any) => {
      if (shouldThrowOptimisticLock && saveCallCount === 0) {
        saveCallCount++;
        throw new OptimisticLockVersionMismatchError("Investment", 1, 2);
      }
      saveCallCount++;
      const result = saveResults[saveCallCount - 1] ?? data;
      return result;
    }),
  };
  return manager;
}

describe("InvestmentService optimistic locking", () => {
  it("retries investment allocation on OptimisticLockVersionMismatchError", async () => {
    const mockSaveResults = [
      { id: "inv-1", status: InvestmentStatus.PENDING, investmentAmount: "100.0000", expectedReturn: "105.0000" },
    ];

    const mockEntityManager = createMockEntityManager(mockSaveResults, true);
    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb: any) => cb(mockEntityManager)),
    } as unknown as DataSource;

    const investmentService = new InvestmentService(mockDataSource);

    const result = await investmentService.createInvestment({
      invoiceId: "invoice-1",
      investorId: "investor-1",
      investmentAmount: "100.0000",
      investorWallet: INVESTOR_WALLET,
    });

    expect(result.status).toBe(InvestmentStatus.PENDING);
    expect(mockEntityManager.save).toHaveBeenCalledTimes(2);
  });

  it("throws after exceeding max retries on persistent optimistic lock conflicts", async () => {
    let throwCount = 0;
    const mockEntityManager = createMockEntityManager([]);
    mockEntityManager.save.mockImplementation(async (entity: any, data: any) => {
      throwCount++;
      throw new OptimisticLockVersionMismatchError("Investment", 1, throwCount);
    });

    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb: any) => cb(mockEntityManager)),
    } as unknown as DataSource;

    const investmentService = new InvestmentService(mockDataSource);

    await expect(
      investmentService.createInvestment({
        invoiceId: "invoice-1",
        investorId: "investor-1",
        investmentAmount: "100.0000",
        investorWallet: INVESTOR_WALLET,
      }),
    ).rejects.toThrow(OptimisticLockVersionMismatchError);

    expect(mockEntityManager.save).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-optimistic-lock errors", async () => {
    const mockEntityManager = createMockEntityManager([]);
    mockEntityManager.save.mockRejectedValueOnce(new Error("Database connection lost"));

    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb: any) => cb(mockEntityManager)),
    } as unknown as DataSource;

    const investmentService = new InvestmentService(mockDataSource);

    await expect(
      investmentService.createInvestment({
        invoiceId: "invoice-1",
        investorId: "investor-1",
        investmentAmount: "100.0000",
        investorWallet: INVESTOR_WALLET,
      }),
    ).rejects.toThrow("Database connection lost");

    expect(mockEntityManager.save).toHaveBeenCalledTimes(1);
  });

  it("handles 10 simultaneous investment requests without over-funding", async () => {
    const invoice = {
      id: "invoice-1",
      sellerId: "seller-1",
      amount: "1000.0000",
      netAmount: "1000.0000",
      status: InvoiceStatus.PUBLISHED,
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    } as Invoice;

    const investments = new Map<string, Investment>();
    let saveCallCount = 0;

    const manager = {
      createQueryBuilder: jest.fn().mockReturnValue(createMockQueryBuilder(invoice)),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation((entity: any, data: any) => data),
      save: jest.fn().mockImplementation(async (entity: any, data: any) => {
        saveCallCount++;
        const investment = { ...data, id: `inv-${saveCallCount}` } as Investment;
        investments.set(investment.id, investment);
        return investment;
      }),
    };

    let txChain: Promise<unknown> = Promise.resolve();
    const dataSource = {
      transaction: (callback: (em: typeof manager) => Promise<unknown>) => {
        const next = txChain.then(() => callback(manager));
        txChain = next.catch(() => {});
        return next;
      },
    } as unknown as DataSource;

    const investmentService = new InvestmentService(dataSource);

    const requests = Array.from({ length: 10 }, (_, i) => ({
      invoiceId: "invoice-1",
      investorId: `investor-${i}`,
      investmentAmount: "100.0000",
      investorWallet: `GINVESTOR${i}1234567890ABCDEFGHIJKLMNOPQRSTUV`,
    }));

    const results = await Promise.allSettled(
      requests.map((input) => investmentService.createInvestment(input)),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(0);
    expect(investments.size).toBe(10);

    const totalInvested = [...investments.values()].reduce(
      (sum, inv) => sum.plus(new Decimal(inv.investmentAmount)),
      new Decimal(0),
    );
    expect(totalInvested.toFixed(4)).toBe("1000.0000");
  });
});
