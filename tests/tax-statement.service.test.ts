import request from "supertest";
import express from "express";
import { DataSource } from "typeorm";
import {
  TaxStatementService,
  InMemoryObjectStorage,
} from "../src/services/tax-statement.service";
import { createTaxStatementRouter } from "../src/routes/tax-statement.routes";
import { Investment } from "../src/models/Investment.model";
import { Invoice } from "../src/models/Invoice.model";
import { InvestmentStatus, InvoiceStatus, KYCStatus } from "../src/types/enums";
import { createErrorMiddleware } from "../src/middleware/error.middleware";
import { logger } from "../src/observability/logger";

describe("TaxStatementService (Issue #873)", () => {
  const USER_ID = "investor-uuid-123";
  const OTHER_USER_ID = "other-investor-456";

  function createMockDataSource(investments: Partial<Investment>[] = []) {
    const investmentRows = [...investments];

    return {
      getRepository: (entity: unknown) => {
        if (entity === Investment) {
          return {
            find: jest.fn(async (options: any) => {
              const where = options?.where ?? {};
              return investmentRows.filter((inv) => {
                if (where.investorId && inv.investorId !== where.investorId) return false;
                if (where.status && inv.status !== where.status) return false;
                return true;
              });
            }),
          };
        }
        throw new Error(`Unexpected entity: ${String(entity)}`);
      },
      _investments: investmentRows,
    } as unknown as DataSource & { _investments: Partial<Investment>[] };
  }

  describe("build(userId, year)", () => {
    it("aggregates settled payouts across multiple invoices into principal and yield", async () => {
      const invoice1: Partial<Invoice> = {
        id: "inv-1",
        invoiceNumber: "INV-2026-001",
        customerName: "Acme Logistics",
        status: InvoiceStatus.SETTLED,
      };

      const invoice2: Partial<Invoice> = {
        id: "inv-2",
        invoiceNumber: "INV-2026-002",
        customerName: "Global Trade Inc",
        status: InvoiceStatus.SETTLED,
      };

      // Two investments on invoice 1 (e.g. initial + follow-up) and one on invoice 2
      const mockInvestments: Partial<Investment>[] = [
        {
          id: "inv-entry-1",
          investorId: USER_ID,
          invoiceId: "inv-1",
          invoice: invoice1 as Invoice,
          investmentAmount: "1000.0000",
          actualReturn: "1100.0000", // $100 yield
          status: InvestmentStatus.SETTLED,
          updatedAt: new Date("2026-04-15T10:00:00Z"),
        },
        {
          id: "inv-entry-2",
          investorId: USER_ID,
          invoiceId: "inv-1",
          invoice: invoice1 as Invoice,
          investmentAmount: "500.0000",
          actualReturn: "550.0000", // $50 yield
          status: InvestmentStatus.SETTLED,
          updatedAt: new Date("2026-05-20T14:30:00Z"),
        },
        {
          id: "inv-entry-3",
          investorId: USER_ID,
          invoiceId: "inv-2",
          invoice: invoice2 as Invoice,
          investmentAmount: "2000.0000",
          actualReturn: "2300.0000", // $300 yield
          status: InvestmentStatus.SETTLED,
          updatedAt: new Date("2026-09-10T08:00:00Z"),
        },
      ];

      const ds = createMockDataSource(mockInvestments);
      const service = new TaxStatementService(ds);

      const statement = await service.build(USER_ID, 2026);

      expect(statement.userId).toBe(USER_ID);
      expect(statement.year).toBe(2026);
      expect(statement.invoices).toHaveLength(2);

      // Invoice 1 aggregation (1000 + 500 principal = 1500, 100 + 50 yield = 150)
      const row1 = statement.invoices.find((r) => r.invoiceId === "inv-1");
      expect(row1).toBeDefined();
      expect(row1?.invoiceNumber).toBe("INV-2026-001");
      expect(row1?.customerName).toBe("Acme Logistics");
      expect(row1?.principal).toBe("1500.00");
      expect(row1?.yield).toBe("150.00");
      expect(row1?.totalPayout).toBe("1650.00");

      // Invoice 2 aggregation
      const row2 = statement.invoices.find((r) => r.invoiceId === "inv-2");
      expect(row2).toBeDefined();
      expect(row2?.invoiceNumber).toBe("INV-2026-002");
      expect(row2?.customerName).toBe("Global Trade Inc");
      expect(row2?.principal).toBe("2000.00");
      expect(row2?.yield).toBe("300.00");
      expect(row2?.totalPayout).toBe("2300.00");

      // Grand totals: 1500 + 2000 = 3500 principal, 150 + 300 = 450 yield, 3950 total payout
      expect(statement.totalPrincipal).toBe("3500.00");
      expect(statement.totalYield).toBe("450.00");
      expect(statement.totalPayout).toBe("3950.00");
    });

    it("returns an empty statement with zero totals when no payouts exist for that calendar year", async () => {
      const ds = createMockDataSource([]);
      const service = new TaxStatementService(ds);

      const statement = await service.build(USER_ID, 2025);

      expect(statement.userId).toBe(USER_ID);
      expect(statement.year).toBe(2025);
      expect(statement.totalPrincipal).toBe("0.00");
      expect(statement.totalYield).toBe("0.00");
      expect(statement.totalPayout).toBe("0.00");
      expect(statement.invoices).toHaveLength(0);
    });

    it("excludes payouts from other calendar years and other users", async () => {
      const mockInvestments: Partial<Investment>[] = [
        // 2026 payout for this user
        {
          id: "inv-2026",
          investorId: USER_ID,
          invoiceId: "inv-2026",
          investmentAmount: "1000.0000",
          actualReturn: "1100.0000",
          status: InvestmentStatus.SETTLED,
          updatedAt: new Date("2026-06-01T00:00:00Z"),
        },
        // 2025 payout for this user (should be excluded when querying 2026)
        {
          id: "inv-2025",
          investorId: USER_ID,
          invoiceId: "inv-2025",
          investmentAmount: "5000.0000",
          actualReturn: "5500.0000",
          status: InvestmentStatus.SETTLED,
          updatedAt: new Date("2025-11-15T00:00:00Z"),
        },
        // 2026 payout for a different user (should be excluded)
        {
          id: "inv-other-user",
          investorId: OTHER_USER_ID,
          invoiceId: "inv-other",
          investmentAmount: "3000.0000",
          actualReturn: "3300.0000",
          status: InvestmentStatus.SETTLED,
          updatedAt: new Date("2026-08-01T00:00:00Z"),
        },
      ];

      const ds = createMockDataSource(mockInvestments);
      const service = new TaxStatementService(ds);

      const statement2026 = await service.build(USER_ID, 2026);
      expect(statement2026.totalPrincipal).toBe("1000.00");
      expect(statement2026.totalYield).toBe("100.00");
      expect(statement2026.totalPayout).toBe("1100.00");
      expect(statement2026.invoices).toHaveLength(1);
      expect(statement2026.invoices[0].invoiceId).toBe("inv-2026");

      const statement2025 = await service.build(USER_ID, 2025);
      expect(statement2025.totalPrincipal).toBe("5000.00");
      expect(statement2025.totalYield).toBe("500.00");
      expect(statement2025.totalPayout).toBe("5500.00");
      expect(statement2025.invoices).toHaveLength(1);
      expect(statement2025.invoices[0].invoiceId).toBe("inv-2025");
    });
  });

  describe("CSV Generation", () => {
    it("generates CSV with matching rows and totals", async () => {
      const mockInvestments: Partial<Investment>[] = [
        {
          id: "inv-1",
          investorId: USER_ID,
          invoiceId: "inv-1",
          invoice: {
            id: "inv-1",
            invoiceNumber: "INV-101",
            customerName: "Corp A",
          } as Invoice,
          investmentAmount: "1000.0000",
          actualReturn: "1150.0000",
          status: InvestmentStatus.SETTLED,
          updatedAt: new Date("2026-03-10T00:00:00Z"),
        },
      ];

      const ds = createMockDataSource(mockInvestments);
      const service = new TaxStatementService(ds);

      const statement = await service.build(USER_ID, 2026);
      const csv = service.buildCsv(statement);

      expect(csv).toContain("Invoice ID,Invoice Number,Customer Name,Settlement Date,Principal,Yield,Total Payout");
      expect(csv).toContain('inv-1,INV-101,"Corp A",2026-03-10,1000.00,150.00,1150.00');
      expect(csv).toContain("Total,,,,1000.00,150.00,1150.00");
    });
  });

  describe("PDF Generation and Object Storage Caching", () => {
    it("generates a valid PDF buffer with pdfkit and caches it in object storage", async () => {
      const mockInvestments: Partial<Investment>[] = [
        {
          id: "inv-1",
          investorId: USER_ID,
          invoiceId: "inv-1",
          invoice: {
            id: "inv-1",
            invoiceNumber: "INV-201",
            customerName: "Widget Corp",
          } as Invoice,
          investmentAmount: "2500.0000",
          actualReturn: "2750.0000",
          status: InvestmentStatus.SETTLED,
          updatedAt: new Date("2026-07-01T00:00:00Z"),
        },
      ];

      const ds = createMockDataSource(mockInvestments);
      const storage = new InMemoryObjectStorage();
      const service = new TaxStatementService(ds, storage);

      expect(await service.hasCachedPdf(USER_ID, 2026)).toBe(false);

      // First call generates and stores PDF
      const pdfBuffer1 = await service.getOrGeneratePdf(USER_ID, 2026);
      expect(Buffer.isBuffer(pdfBuffer1)).toBe(true);
      expect(pdfBuffer1.toString("ascii", 0, 4)).toBe("%PDF");
      expect(await service.hasCachedPdf(USER_ID, 2026)).toBe(true);

      // Second call retrieves from cache
      const spyStorageGet = jest.spyOn(storage, "get");
      const pdfBuffer2 = await service.getOrGeneratePdf(USER_ID, 2026);
      expect(spyStorageGet).toHaveBeenCalledWith(service.getStorageKey(USER_ID, 2026));
      expect(pdfBuffer2).toEqual(pdfBuffer1);
    });

    it("invalidates cached PDF when a new payout is recorded for that year", async () => {
      const ds = createMockDataSource([]);
      const storage = new InMemoryObjectStorage();
      const service = new TaxStatementService(ds, storage);

      // Cache an initial statement PDF
      await service.getOrGeneratePdf(USER_ID, 2026);
      expect(await service.hasCachedPdf(USER_ID, 2026)).toBe(true);

      // Invalidate cache for 2026
      await service.invalidate(USER_ID, 2026);
      expect(await service.hasCachedPdf(USER_ID, 2026)).toBe(false);
    });
  });

  describe("HTTP Routes (Issue #873)", () => {
    let app: express.Application;
    let mockAuthService: any;
    let service: TaxStatementService;
    let storage: InMemoryObjectStorage;

    const authUser = {
      id: USER_ID,
      stellarAddress: "GINVESTOR",
      kycStatus: KYCStatus.APPROVED,
    };

    beforeEach(() => {
      const mockInvestments: Partial<Investment>[] = [
        {
          id: "inv-entry-1",
          investorId: USER_ID,
          invoiceId: "inv-1",
          invoice: {
            id: "inv-1",
            invoiceNumber: "INV-100",
            customerName: "Stellar Buyer",
          } as Invoice,
          investmentAmount: "1000.0000",
          actualReturn: "1120.0000",
          status: InvestmentStatus.SETTLED,
          updatedAt: new Date("2026-05-01T00:00:00Z"),
        },
      ];

      const ds = createMockDataSource(mockInvestments);
      storage = new InMemoryObjectStorage();
      service = new TaxStatementService(ds, storage);

      mockAuthService = {
        getCurrentUser: jest.fn().mockImplementation((token: string) => {
          if (token === "valid-investor-token") return Promise.resolve(authUser);
          throw new Error("Invalid token");
        }),
      };

      app = express();
      app.use(express.json());
      app.use(
        "/api/investors",
        createTaxStatementRouter({
          taxStatementService: service,
          authService: mockAuthService,
        }),
      );
      app.use(createErrorMiddleware(logger));
    });

    it("GET /api/investors/me/statements/:year returns JSON statement totals", async () => {
      const res = await request(app)
        .get("/api/investors/me/statements/2026")
        .set("Authorization", "Bearer valid-investor-token")
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.year).toBe(2026);
      expect(res.body.data.userId).toBe(USER_ID);
      expect(res.body.data.totalPrincipal).toBe("1000.00");
      expect(res.body.data.totalYield).toBe("120.00");
      expect(res.body.data.totalPayout).toBe("1120.00");
      expect(res.body.data.invoices).toHaveLength(1);
    });

    it("GET /api/investors/me/statements/:year.csv streams CSV statement", async () => {
      const res = await request(app)
        .get("/api/investors/me/statements/2026.csv")
        .set("Authorization", "Bearer valid-investor-token")
        .expect(200);

      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.text).toContain("Invoice ID,Invoice Number,Customer Name,Settlement Date,Principal,Yield,Total Payout");
      expect(res.text).toContain("1000.00,120.00,1120.00");
    });

    it("GET /api/investors/me/statements/:year.pdf returns application/pdf", async () => {
      const res = await request(app)
        .get("/api/investors/me/statements/2026.pdf")
        .set("Authorization", "Bearer valid-investor-token")
        .expect(200);

      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.body.toString("ascii", 0, 4)).toBe("%PDF");
      expect(await storage.get(service.getStorageKey(USER_ID, 2026))).not.toBeNull();
    });

    it("blocks unauthenticated requests with 401", async () => {
      await request(app)
        .get("/api/investors/me/statements/2026")
        .expect(401);

      await request(app)
        .get("/api/investors/me/statements/2026.pdf")
        .expect(401);

      await request(app)
        .get("/api/investors/me/statements/2026.csv")
        .expect(401);
    });
  });
});
