import crypto from "crypto";
import { DataSource, EntityManager } from "typeorm";
import { Decimal } from "decimal.js";
import { InvestmentService } from "../../src/services/investment.service";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { InvestorAcknowledgement } from "../../src/models/InvestorAcknowledgement.model";
import { InvoiceStatus, InvestmentStatus } from "../../src/types/enums";
import { ServiceError } from "../../src/utils/service-error";

describe("Investment Capacity Boundaries & Concurrency Hardening", () => {
  function createInvoice(overrides: Partial<Invoice> = {}): Invoice {
    return {
      id: crypto.randomUUID(),
      sellerId: crypto.randomUUID(),
      invoiceNumber: "INV-BOUND-001",
      customerName: "Boundary Test Customer",
      amount: "1000.0000",
      discountRate: "0.00",
      netAmount: "1000.0000",
      fundedAmount: "0.0000",
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      ipfsHash: "QmTestHash",
      riskScore: null,
      status: InvoiceStatus.PUBLISHED,
      smartContractId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      version: 1,
      seller: undefined as unknown as Invoice["seller"],
      investments: [],
      transactions: [],
      ...overrides,
    } as unknown as Invoice;
  }

  function createMockDataSource(invoice: Invoice) {
    const invoices = new Map<string, Invoice>([[invoice.id, { ...invoice } as unknown as Invoice]]);
    const investments = new Map<string, Investment>();

    const manager = {
      createQueryBuilder: (_entity?: unknown, _alias?: string) => {
        let updateParams: Record<string, unknown> = {};
        const builder = {
          setLock: () => builder,
          where: (_clause: string, params: { id: string }) => {
            Object.assign(updateParams, params);
            return builder;
          },
          andWhere: (_clause: string, params?: Record<string, unknown>) => {
            if (params) Object.assign(updateParams, params);
            return builder;
          },
          setParameter: (k: string, v: unknown) => {
            updateParams[k] = v;
            return builder;
          },
          update: () => builder,
          set: () => builder,
          getOne: async () => invoices.get(invoice.id) ?? null,
          execute: async () => {
            const current = invoices.get(invoice.id);
            if (!current) return { affected: 0 };
            const amount = new Decimal(String(updateParams.amount || 0));
            const newFunded = new Decimal(current.fundedAmount || "0").plus(amount);
            if (newFunded.gt(new Decimal(current.netAmount))) {
              return { affected: 0 };
            }
            if (updateParams.version !== undefined && current.version !== updateParams.version) {
              return { affected: 0 };
            }
            current.fundedAmount = newFunded.toFixed(4);
            current.version = (current.version ?? 0) + 1;
            return { affected: 1 };
          },
        };
        return builder;
      },
      find: async (
        entity: unknown,
        options: { where: Record<string, unknown> | Record<string, unknown>[] }
      ) => {
        if (entity === Investment) {
          const clauses = Array.isArray(options.where) ? options.where : [options.where];
          return [...investments.values()].filter((inv) =>
            clauses.some((clause) =>
              Object.entries(clause).every(
                ([k, v]) => (inv as unknown as Record<string, unknown>)[k] === v
              )
            )
          );
        }
        return [];
      },
      findOne: async (entity: unknown, { where }: { where: Record<string, unknown> }) => {
        if (entity === Invoice) return invoices.get(where.id as string) ?? null;
        if (entity === Investment) {
          return (
            [...investments.values()].find((inv) =>
              Object.entries(where).every(
                ([k, v]) => (inv as unknown as Record<string, unknown>)[k] === v
              )
            ) ?? null
          );
        }
        return null;
      },
      create: (_entity: unknown, data: Partial<Investment>) =>
        ({
          id: crypto.randomUUID(),
          status: InvestmentStatus.PENDING,
          createdAt: new Date(),
          ...data,
        }) as Investment,
      save: async (entity: unknown, data: Investment | Invoice) => {
        if (entity === Investment) investments.set((data as Investment).id, data as Investment);
        else if (entity === Invoice) invoices.set((data as Invoice).id, data as Invoice);
        return data;
      },
    };

    const dataSource = {
      transaction: async (callback: (em: typeof manager) => Promise<unknown>) => callback(manager),
      getRepository: (entity: unknown) => {
        if (entity === InvestorAcknowledgement) {
          return {
            findOne: jest.fn().mockResolvedValue({
              walletAddress: "test",
              termsVersion: "1.0",
              acknowledgedAt: new Date(),
            }),
          };
        }
        return manager;
      },
    } as unknown as DataSource;

    return { dataSource, invoices, investments, manager };
  }

  describe("Capacity Boundary Checks", () => {
    it("accepts an investment for exactly the full remaining capacity and transitions to FUNDED", async () => {
      const invoice = createInvoice({ netAmount: "1000.0000" });
      const { dataSource, invoices, investments } = createMockDataSource(invoice);
      const service = new InvestmentService(dataSource);

      const result = await service.createInvestment({
        invoiceId: invoice.id,
        investorId: "investor-1",
        investmentAmount: "1000.0000",
        investorWallet: "G" + "A".repeat(55),
      });

      expect(result).toBeDefined();
      expect(result.investmentAmount).toBe("1000.0000");
      expect(investments.size).toBe(1);
      expect(invoices.get(invoice.id)!.status).toBe(InvoiceStatus.FUNDED);
      expect(invoices.get(invoice.id)!.fundedAmount).toBe("1000.0000");
    });

    it("rejects an investment that exceeds capacity by the smallest decimal increment (0.0001)", async () => {
      const invoice = createInvoice({ netAmount: "1000.0000" });
      const { dataSource, investments } = createMockDataSource(invoice);
      const service = new InvestmentService(dataSource);

      await expect(
        service.createInvestment({
          invoiceId: invoice.id,
          investorId: "investor-1",
          investmentAmount: "1000.0001",
          investorWallet: "G" + "A".repeat(55),
        })
      ).rejects.toMatchObject({
        code: "INSUFFICIENT_CAPACITY",
        statusCode: 400,
      });

      // No record stranded
      expect(investments.size).toBe(0);
    });

    it("accepts capacity minus 0.0001, then accepts exactly 0.0001 dust to complete", async () => {
      const invoice = createInvoice({ netAmount: "1000.0000" });
      const { dataSource, invoices, investments } = createMockDataSource(invoice);
      const service = new InvestmentService(dataSource);

      // 999.9999 accepted
      await service.createInvestment({
        invoiceId: invoice.id,
        investorId: "investor-1",
        investmentAmount: "999.9999",
        investorWallet: "G" + "A".repeat(55),
      });

      expect(investments.size).toBe(1);
      expect(invoices.get(invoice.id)!.status).toBe(InvoiceStatus.PUBLISHED);

      // 0.0002 rejected (exceeds remaining 0.0001)
      await expect(
        service.createInvestment({
          invoiceId: invoice.id,
          investorId: "investor-2",
          investmentAmount: "0.0002",
          investorWallet: "G" + "B".repeat(55),
        })
      ).rejects.toMatchObject({
        code: "INSUFFICIENT_CAPACITY",
        statusCode: 400,
      });

      // Exactly 0.0001 accepted and finishes funding
      await service.createInvestment({
        invoiceId: invoice.id,
        investorId: "investor-3",
        investmentAmount: "0.0001",
        investorWallet: "G" + "C".repeat(55),
      });

      expect(investments.size).toBe(2);
      expect(invoices.get(invoice.id)!.status).toBe(InvoiceStatus.FUNDED);
      expect(invoices.get(invoice.id)!.fundedAmount).toBe("1000.0000");
    });
  });

  describe("Decimal Validation Before & During Transaction", () => {
    it("rejects non-numeric string amounts before starting transaction", async () => {
      const invoice = createInvoice();
      const { dataSource } = createMockDataSource(invoice);
      const service = new InvestmentService(dataSource);

      await expect(
        service.createInvestment({
          invoiceId: invoice.id,
          investorId: "investor-1",
          investmentAmount: "not-a-number",
          investorWallet: "G" + "A".repeat(55),
        })
      ).rejects.toMatchObject({
        code: "INVALID_AMOUNT",
        statusCode: 400,
      });
    });

    it("rejects zero and negative amounts", async () => {
      const invoice = createInvoice();
      const { dataSource } = createMockDataSource(invoice);
      const service = new InvestmentService(dataSource);

      await expect(
        service.createInvestment({
          invoiceId: invoice.id,
          investorId: "investor-1",
          investmentAmount: "0",
          investorWallet: "G" + "A".repeat(55),
        })
      ).rejects.toMatchObject({
        code: "INVALID_AMOUNT",
        statusCode: 400,
      });

      await expect(
        service.createInvestment({
          invoiceId: invoice.id,
          investorId: "investor-1",
          investmentAmount: "-50.0000",
          investorWallet: "G" + "A".repeat(55),
        })
      ).rejects.toMatchObject({
        code: "INVALID_AMOUNT",
        statusCode: 400,
      });
    });

    it("rejects amounts with more than 4 decimal places", async () => {
      const invoice = createInvoice();
      const { dataSource } = createMockDataSource(invoice);
      const service = new InvestmentService(dataSource);

      await expect(
        service.createInvestment({
          invoiceId: invoice.id,
          investorId: "investor-1",
          investmentAmount: "10.12345",
          investorWallet: "G" + "A".repeat(55),
        })
      ).rejects.toMatchObject({
        code: "INVALID_AMOUNT",
        statusCode: 400,
      });
    });
  });

  describe("Concurrency & Conflict Responses", () => {
    it("ensures one concurrent request wins and other receives retry-safe conflict when racing for capacity", async () => {
      const invoice = createInvoice({ netAmount: "500.0000" });
      const { dataSource, invoices, investments, manager } = createMockDataSource(invoice);
      const service = new InvestmentService(dataSource);

      let raceAttempt = 0;
      // Simulate conditional update conflict on the second request
      jest.spyOn(manager, "createQueryBuilder").mockImplementation((() => {
        const builder = {
          setLock: () => builder,
          where: () => builder,
          andWhere: () => builder,
          setParameter: () => builder,
          update: () => builder,
          set: () => builder,
          getOne: async () => invoices.get(invoice.id) ?? null,
          execute: async () => {
            raceAttempt++;
            if (raceAttempt > 1) {
              // Simulates race conflict on second concurrent writer
              return { affected: 0 };
            }
            const inv = invoices.get(invoice.id)!;
            inv.fundedAmount = "500.0000";
            inv.version = (inv.version ?? 0) + 1;
            return { affected: 1 };
          },
        };
        return builder;
      }) as any);

      const [res1, res2] = await Promise.allSettled([
        service.createInvestment({
          invoiceId: invoice.id,
          investorId: "investor-1",
          investmentAmount: "500.0000",
          investorWallet: "G" + "A".repeat(55),
        }),
        service.createInvestment({
          invoiceId: invoice.id,
          investorId: "investor-2",
          investmentAmount: "500.0000",
          investorWallet: "G" + "B".repeat(55),
        }),
      ]);

      const fulfilled = [res1, res2].filter((r) => r.status === "fulfilled");
      const rejected = [res1, res2].filter((r): r is PromiseRejectedResult => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // The losing request fails with conflict or insufficient capacity, never commits over capacity
      const failureReason = rejected[0].reason as ServiceError;
      expect(["CONCURRENT_INVESTMENT_CONFLICT", "INSUFFICIENT_CAPACITY"]).toContain(failureReason.code);

      // Only 1 investment row committed
      expect(investments.size).toBe(1);
      expect(invoices.get(invoice.id)!.status).toBe(InvoiceStatus.FUNDED);
    });

    it("leaves no stranded pending investment when an error or conflict occurs", async () => {
      const invoice = createInvoice({ netAmount: "500.0000" });
      const { dataSource, investments, manager } = createMockDataSource(invoice);
      const service = new InvestmentService(dataSource);

      // Make save fail after investment row creation
      jest.spyOn(manager, "save").mockImplementation(async (entity: unknown) => {
        if (entity === Investment) {
          throw new Error("Simulated database failure");
        }
        return entity as any;
      });

      await expect(
        service.createInvestment({
          invoiceId: invoice.id,
          investorId: "investor-fail",
          investmentAmount: "100.0000",
          investorWallet: "G" + "A".repeat(55),
        })
      ).rejects.toThrow("Simulated database failure");

      // No stranded record exists
      expect(investments.size).toBe(0);
    });
  });
});
