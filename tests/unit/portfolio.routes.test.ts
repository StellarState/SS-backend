import express from "express";
import request from "supertest";
import { createPortfolioRouter } from "../../src/routes/portfolio.routes";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { logger } from "../../src/observability/logger";
import { InvestmentStatus, UserType } from "../../src/types/enums";
import { ServiceError } from "../../src/utils/service-error";

describe("Portfolio Routes (GET /portfolio & GET /api/v1/portfolio)", () => {
  let app: express.Application;
  let mockPortfolioService: any;
  let mockAuthService: any;

  const mockInvestorUser = {
    id: "investor-u1",
    userType: UserType.INVESTOR,
    stellarAddress: "G" + "A".repeat(55),
  };

  const samplePage = {
    summary: {
      totalInvested: "500.0000",
      currentPortfolioValue: "550.0000",
      realisedReturns: "0.0000",
      realisedPnl: "0.0000",
    },
    positions: [
      {
        investmentId: "inv-1",
        invoiceId: "invoice-1",
        invoiceStatus: "published",
        status: InvestmentStatus.CONFIRMED,
        amountInvested: "500.0000",
        expectedReturn: "550.0000",
        currentValue: "550.0000",
        settlementAmount: null,
        realisedPnl: null,
        fundingDeadline: null,
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    ],
    nextCursor: "MjAyNi0wNS0wMVQwMDowMDowMC4wMDBafGludi0x",
    hasMore: true,
  };

  beforeEach(() => {
    mockPortfolioService = {
      getPortfolio: jest.fn().mockResolvedValue(samplePage),
    };

    mockAuthService = {
      getCurrentUser: jest.fn().mockResolvedValue(mockInvestorUser),
    };

    app = express();
    app.use(express.json());

    const router = createPortfolioRouter({
      authService: mockAuthService,
      portfolioService: mockPortfolioService,
    });
    app.use("/api/v1/portfolio", router);
    app.use("/portfolio", router);
    app.use(createErrorMiddleware(logger));
  });

  describe("Keyset Cursor Pagination & Next-Cursor Exposure", () => {
    it("returns 200 with positions, summary, and exposes X-Next-Cursor header", async () => {
      const res = await request(app)
        .get("/api/v1/portfolio?cursor=some-cursor&limit=10")
        .set("Authorization", "Bearer mock-token")
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.positions).toHaveLength(1);
      expect(res.body.data.nextCursor).toBe(samplePage.nextCursor);
      expect(res.headers["x-next-cursor"]).toBe(samplePage.nextCursor);
      // When cursor is used, Deprecation header should NOT be set
      expect(res.headers["deprecation"]).toBeUndefined();

      expect(mockPortfolioService.getPortfolio).toHaveBeenCalledWith("investor-u1", {
        cursor: "some-cursor",
        limit: 10,
        page: undefined,
        offset: undefined,
        status: undefined,
        invoiceStatus: undefined,
        minAmount: undefined,
        maxAmount: undefined,
        startDate: undefined,
        endDate: undefined,
        sortBy: undefined,
        sortOrder: undefined,
      });
    });

    it("works identically on root /portfolio path", async () => {
      const res = await request(app)
        .get("/portfolio?limit=5")
        .set("Authorization", "Bearer mock-token")
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(samplePage);
    });
  });

  describe("Deprecation Behavior for Legacy Offset Pagination", () => {
    it("emits Deprecation and Warning headers when legacy page parameter is used", async () => {
      const res = await request(app)
        .get("/api/v1/portfolio?page=2&limit=10")
        .set("Authorization", "Bearer mock-token")
        .expect(200);

      expect(res.headers["deprecation"]).toBe("true");
      expect(res.headers["warning"]).toContain("Offset-based pagination is deprecated");
      expect(mockPortfolioService.getPortfolio).toHaveBeenCalledWith(
        "investor-u1",
        expect.objectContaining({
          page: 2,
          limit: 10,
          cursor: null,
        })
      );
    });

    it("emits Deprecation and Warning headers when legacy offset parameter is used", async () => {
      const res = await request(app)
        .get("/api/v1/portfolio?offset=20&limit=10")
        .set("Authorization", "Bearer mock-token")
        .expect(200);

      expect(res.headers["deprecation"]).toBe("true");
      expect(res.headers["warning"]).toContain("Offset-based pagination is deprecated");
      expect(mockPortfolioService.getPortfolio).toHaveBeenCalledWith(
        "investor-u1",
        expect.objectContaining({
          offset: 20,
          limit: 10,
          cursor: null,
        })
      );
    });
  });

  describe("Sorting & Filter Forwarding", () => {
    it("forwards sort and filter parameters to service", async () => {
      await request(app)
        .get(
          "/api/v1/portfolio?status=confirmed&invoiceStatus=published&minAmount=100&maxAmount=1000&sortBy=investmentAmount&sortOrder=ASC"
        )
        .set("Authorization", "Bearer mock-token")
        .expect(200);

      expect(mockPortfolioService.getPortfolio).toHaveBeenCalledWith(
        "investor-u1",
        expect.objectContaining({
          status: "confirmed",
          invoiceStatus: "published",
          minAmount: "100",
          maxAmount: "1000",
          sortBy: "investmentAmount",
          sortOrder: "ASC",
        })
      );
    });
  });

  describe("Consistent Cursor Validation Error Handling", () => {
    it("returns structured 400 INVALID_CURSOR when service rejects cursor", async () => {
      mockPortfolioService.getPortfolio.mockRejectedValue(
        new ServiceError("INVALID_CURSOR", "Invalid portfolio cursor", 400)
      );

      const res = await request(app)
        .get("/api/v1/portfolio?cursor=invalid-bad-cursor")
        .set("Authorization", "Bearer mock-token")
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("INVALID_CURSOR");
      expect(res.body.error.message).toBe("Invalid portfolio cursor");
    });
  });
});
