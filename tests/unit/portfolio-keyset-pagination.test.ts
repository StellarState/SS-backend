import { PortfolioService, encodeCursor, decodeCursor } from "../../src/services/portfolio.service";
import { InvestmentStatus, InvoiceStatus } from "../../src/types/enums";
import { ServiceError } from "../../src/utils/service-error";

describe("Portfolio Keyset Pagination & Filtering Unit Tests", () => {
  function makeMockService(investments: Array<Record<string, unknown>>) {
    let whereClause = "";
    let whereParams: Record<string, unknown> = {};
    const andWhereClauses: string[] = [];
    const andWhereParams: Record<string, unknown> = {};
    let orderClause = "";
    let addOrderClause = "";
    let limitVal = 20;
    let skipVal = 0;

    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockImplementation((clause: string, params: Record<string, unknown>) => {
        whereClause = clause;
        whereParams = params;
        return qb;
      }),
      andWhere: jest.fn().mockImplementation((clause: string, params?: Record<string, unknown>) => {
        andWhereClauses.push(clause);
        if (params) Object.assign(andWhereParams, params);
        return qb;
      }),
      orderBy: jest.fn().mockImplementation((col: string, order: string) => {
        orderClause = `${col} ${order}`;
        return qb;
      }),
      addOrderBy: jest.fn().mockImplementation((col: string, order: string) => {
        addOrderClause = `${col} ${order}`;
        return qb;
      }),
      take: jest.fn().mockImplementation((val: number) => {
        limitVal = val;
        return qb;
      }),
      skip: jest.fn().mockImplementation((val: number) => {
        skipVal = val;
        return qb;
      }),
      getMany: jest.fn().mockImplementation(async () => {
        let filtered = [...investments];

        // Apply cursor filter if present in andWhereParams
        if (andWhereParams.cursorVal && andWhereParams.cursorId) {
          const isDesc = orderClause.includes("DESC");
          const cursorVal = andWhereParams.cursorVal;
          const cursorId = andWhereParams.cursorId as string;

          filtered = filtered.filter((inv) => {
            const val =
              cursorVal instanceof Date
                ? new Date(inv.createdAt as string | Date)
                : (inv.investmentAmount as string);
            const compVal = cursorVal instanceof Date ? (cursorVal as Date).getTime() : cursorVal;
            const currentVal = val instanceof Date ? val.getTime() : val;

            if (isDesc) {
              return (
                currentVal < compVal ||
                (currentVal === compVal && (inv.id as string) < cursorId)
              );
            } else {
              return (
                currentVal > compVal ||
                (currentVal === compVal && (inv.id as string) > cursorId)
              );
            }
          });
        }

        if (skipVal > 0) {
          filtered = filtered.slice(skipVal);
        }
        return filtered.slice(0, limitVal);
      }),
    };

    const repo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      find: jest.fn().mockResolvedValue(investments),
    };
    const dataSource = { getRepository: jest.fn().mockReturnValue(repo) };
    return {
      service: new PortfolioService(dataSource as never),
      qb,
      repo,
      getClauses: () => ({
        whereClause,
        whereParams,
        andWhereClauses,
        andWhereParams,
        orderClause,
        addOrderClause,
        limitVal,
        skipVal,
      }),
    };
  }

  describe("Cursor Encoding & Decoding", () => {
    it("encodes and decodes legacy ISO|id cursor", () => {
      const date = new Date("2026-05-15T12:00:00.000Z");
      const cursor = encodeCursor(date, "inv-123");
      const decoded = decodeCursor(cursor);

      expect(decoded.id).toBe("inv-123");
      expect(decoded.sortBy).toBe("createdAt");
      expect(decoded.sortOrder).toBe("DESC");
      expect(new Date(decoded.value).toISOString()).toBe(date.toISOString());
    });

    it("encodes and decodes keyset JSON cursor with custom sort and direction", () => {
      const cursor = encodeCursor("500.0000", "inv-456", "investmentAmount", "ASC");
      const decoded = decodeCursor(cursor);

      expect(decoded.id).toBe("inv-456");
      expect(decoded.sortBy).toBe("investmentAmount");
      expect(decoded.sortOrder).toBe("ASC");
      expect(decoded.value).toBe("500.0000");
    });

    it("rejects invalid cursors with INVALID_CURSOR 400 error", () => {
      expect(() => decodeCursor("")).toThrow(ServiceError);
      expect(() => decodeCursor("   ")).toThrow(ServiceError);
      expect(() => decodeCursor("not-base64-!@#$")).toThrow(ServiceError);
      // Bad date in pipe format
      const badDateCursor = Buffer.from("invalid-date|id1").toString("base64");
      expect(() => decodeCursor(badDateCursor)).toThrow(ServiceError);
      // Empty ID in pipe format
      const emptyIdCursor = Buffer.from("2026-01-01T00:00:00.000Z|").toString("base64");
      expect(() => decodeCursor(emptyIdCursor)).toThrow(ServiceError);
      // Invalid JSON shape
      const badJsonCursor = Buffer.from(JSON.stringify({ only: "this" })).toString("base64");
      expect(() => decodeCursor(badJsonCursor)).toThrow(ServiceError);

      try {
        decodeCursor("invalid");
      } catch (e: any) {
        expect(e.code).toBe("INVALID_CURSOR");
        expect(e.statusCode).toBe(400);
      }
    });
  });

  describe("Keyset Pagination & Stable Traversal Under Concurrency", () => {
    const mockData = [
      {
        id: "inv-5",
        invoiceId: "invoice-5",
        investorId: "u1",
        investmentAmount: "500.0000",
        expectedReturn: "550.0000",
        actualReturn: null,
        status: InvestmentStatus.CONFIRMED,
        createdAt: new Date("2026-05-05T00:00:00.000Z"),
        invoice: { status: InvoiceStatus.PUBLISHED, fundingDeadline: null },
      },
      {
        id: "inv-4",
        invoiceId: "invoice-4",
        investorId: "u1",
        investmentAmount: "400.0000",
        expectedReturn: "440.0000",
        actualReturn: null,
        status: InvestmentStatus.CONFIRMED,
        createdAt: new Date("2026-05-04T00:00:00.000Z"),
        invoice: { status: InvoiceStatus.PUBLISHED, fundingDeadline: null },
      },
      {
        id: "inv-3",
        invoiceId: "invoice-3",
        investorId: "u1",
        investmentAmount: "300.0000",
        expectedReturn: "330.0000",
        actualReturn: null,
        status: InvestmentStatus.CONFIRMED,
        createdAt: new Date("2026-05-03T00:00:00.000Z"),
        invoice: { status: InvoiceStatus.PUBLISHED, fundingDeadline: null },
      },
      {
        id: "inv-2",
        invoiceId: "invoice-2",
        investorId: "u1",
        investmentAmount: "200.0000",
        expectedReturn: "220.0000",
        actualReturn: null,
        status: InvestmentStatus.CONFIRMED,
        createdAt: new Date("2026-05-02T00:00:00.000Z"),
        invoice: { status: InvoiceStatus.PUBLISHED, fundingDeadline: null },
      },
      {
        id: "inv-1",
        invoiceId: "invoice-1",
        investorId: "u1",
        investmentAmount: "100.0000",
        expectedReturn: "110.0000",
        actualReturn: null,
        status: InvestmentStatus.CONFIRMED,
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        invoice: { status: InvoiceStatus.PUBLISHED, fundingDeadline: null },
      },
    ];

    it("paginates page 1 and generates a valid nextCursor", async () => {
      const { service } = makeMockService(mockData);
      const page1 = await service.getPortfolio("u1", { limit: 2 });

      expect(page1.positions).toHaveLength(2);
      expect(page1.positions[0].investmentId).toBe("inv-5");
      expect(page1.positions[1].investmentId).toBe("inv-4");
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeDefined();
      expect(typeof page1.nextCursor).toBe("string");
    });

    it("fetches page 2 using keyset cursor without omitting or repeating rows", async () => {
      const { service } = makeMockService(mockData);
      const page1 = await service.getPortfolio("u1", { limit: 2 });
      const page2 = await service.getPortfolio("u1", { cursor: page1.nextCursor, limit: 2 });

      expect(page2.positions).toHaveLength(2);
      expect(page2.positions[0].investmentId).toBe("inv-3");
      expect(page2.positions[1].investmentId).toBe("inv-2");
      expect(page2.hasMore).toBe(true);

      const page3 = await service.getPortfolio("u1", { cursor: page2.nextCursor, limit: 2 });
      expect(page3.positions).toHaveLength(1);
      expect(page3.positions[0].investmentId).toBe("inv-1");
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeNull();
    });

    it("handles concurrent new row insertions at head without duplicating rows across pages", async () => {
      // Simulate that after page 1 (inv-5, inv-4) was fetched, a concurrent investment (inv-6) was added at head
      const dataWithConcurrentInsert = [
        {
          id: "inv-6",
          invoiceId: "invoice-6",
          investorId: "u1",
          investmentAmount: "600.0000",
          expectedReturn: "660.0000",
          actualReturn: null,
          status: InvestmentStatus.CONFIRMED,
          createdAt: new Date("2026-05-06T00:00:00.000Z"),
          invoice: { status: InvoiceStatus.PUBLISHED, fundingDeadline: null },
        },
        ...mockData,
      ];

      const { service: initialService } = makeMockService(mockData);
      const page1 = await initialService.getPortfolio("u1", { limit: 2 });

      // Page 2 fetched against the database that now has inv-6
      const { service: concurrentService } = makeMockService(dataWithConcurrentInsert);
      const page2 = await concurrentService.getPortfolio("u1", { cursor: page1.nextCursor, limit: 2 });

      // Keyset cursor continues strictly after inv-4, so page 2 gets inv-3 and inv-2!
      // inv-4 is NOT duplicated, and inv-3 is NOT skipped!
      expect(page2.positions[0].investmentId).toBe("inv-3");
      expect(page2.positions[1].investmentId).toBe("inv-2");
    });
  });

  describe("Sorting & Filtering", () => {
    it("applies status and invoiceStatus filters to query builder", async () => {
      const { service, getClauses } = makeMockService([]);
      await service.getPortfolio("u1", {
        status: InvestmentStatus.CONFIRMED,
        invoiceStatus: InvoiceStatus.PUBLISHED,
      });

      const { andWhereClauses, andWhereParams } = getClauses();
      expect(andWhereClauses.some((c) => c.includes("investment.status = :status"))).toBe(true);
      expect(andWhereParams.status).toBe(InvestmentStatus.CONFIRMED);
      expect(andWhereClauses.some((c) => c.includes("invoice.status = :invoiceStatus"))).toBe(true);
      expect(andWhereParams.invoiceStatus).toBe(InvoiceStatus.PUBLISHED);
    });

    it("applies minAmount and maxAmount filters", async () => {
      const { service, getClauses } = makeMockService([]);
      await service.getPortfolio("u1", {
        minAmount: "100.0000",
        maxAmount: "500.0000",
      });

      const { andWhereClauses, andWhereParams } = getClauses();
      expect(andWhereClauses.some((c) => c.includes("investment.investmentAmount >= :minAmount"))).toBe(true);
      expect(andWhereParams.minAmount).toBe("100.0000");
      expect(andWhereClauses.some((c) => c.includes("investment.investmentAmount <= :maxAmount"))).toBe(true);
      expect(andWhereParams.maxAmount).toBe("500.0000");
    });

    it("applies sort column and direction to query builder", async () => {
      const { service, getClauses } = makeMockService([]);
      await service.getPortfolio("u1", {
        sortBy: "investmentAmount",
        sortOrder: "ASC",
      });

      const { orderClause, addOrderClause } = getClauses();
      expect(orderClause).toBe("investment.investmentAmount ASC");
      expect(addOrderClause).toBe("investment.id ASC");
    });
  });

  describe("Backward Compatibility: Offset Pagination", () => {
    it("uses skip when page or offset is supplied without cursor", async () => {
      const { service, getClauses } = makeMockService([]);
      await service.getPortfolio("u1", { page: 3, limit: 10 });

      const { skipVal, limitVal } = getClauses();
      expect(skipVal).toBe(20); // (3 - 1) * 10
      expect(limitVal).toBe(11); // limit + 1
    });
  });

  describe("Boundary Cases", () => {
    it("returns empty positions and null nextCursor when portfolio is empty", async () => {
      const { service } = makeMockService([]);
      const page = await service.getPortfolio("u1", { limit: 10 });

      expect(page.positions).toEqual([]);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
      expect(page.summary.totalInvested).toBe("0.0000");
    });

    it("handles exact limit match where count === limit", async () => {
      const mockSingle = [
        {
          id: "inv-1",
          invoiceId: "invoice-1",
          investorId: "u1",
          investmentAmount: "100.0000",
          expectedReturn: "110.0000",
          actualReturn: null,
          status: InvestmentStatus.CONFIRMED,
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
          invoice: { status: InvoiceStatus.PUBLISHED, fundingDeadline: null },
        },
      ];
      const { service } = makeMockService(mockSingle);
      const page = await service.getPortfolio("u1", { limit: 1 });

      expect(page.positions).toHaveLength(1);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });
  });
});
