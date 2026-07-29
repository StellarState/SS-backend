import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { createInvoiceRouter } from "../../src/routes/invoice.routes";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { logger } from "../../src/observability/logger";
import { InvoiceStatus } from "../../src/types/enums";

describe("Auth JWT validation: expired token rejection", () => {
  let app: express.Application;
  let mockInvoiceService: any;

  const sellerId = "seller-123";

  const expiredToken = jwt.sign(
    { sub: sellerId, stellarAddress: "GTEST123" },
    "test-secret",
    { expiresIn: "-5m" },
  );

  const validToken = jwt.sign(
    { sub: sellerId, stellarAddress: "GTEST123" },
    "test-secret",
  );

  const mockInvoice = {
    id: "invoice-123",
    sellerId,
    invoiceNumber: "INV-001",
    customerName: "Test Customer",
    amount: "1000.00",
    discountRate: "10.00",
    netAmount: "900.00",
    dueDate: "2024-12-31T00:00:00.000Z",
    status: InvoiceStatus.DRAFT,
    ipfsHash: null,
    riskScore: null,
    smartContractId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    mockInvoiceService = {
      createInvoice: jest.fn(),
      getInvoiceById: jest.fn(),
      getInvoicesBySellerId: jest.fn(),
      updateInvoice: jest.fn(),
      deleteInvoice: jest.fn(),
      publishInvoice: jest.fn(),
      uploadDocument: jest.fn(),
    };

    process.env.JWT_SECRET = "test-secret";

    app = express();
    app.use(express.json());
    app.use(
      "/api/v1/invoices",
      createInvoiceRouter({
        invoiceService: mockInvoiceService,
        config: {
          ipfs: {
            apiUrl: "https://api.pinata.cloud",
            jwt: "test-jwt-token",
            maxFileSizeMB: 10,
            allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"],
            uploadRateLimit: {
              windowMs: 900000,
              maxUploads: 10,
            },
          },
          kyc: { skipVerification: true },
        } as any,
      }),
    );
    app.use(createErrorMiddleware(logger));
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it("rejects GET /api/v1/invoices with expired JWT token", async () => {
    mockInvoiceService.getInvoicesBySellerId.mockResolvedValue({
      invoices: [mockInvoice],
      total: 1,
    });

    const response = await request(app)
      .get("/api/v1/invoices")
      .set("Authorization", `Bearer ${expiredToken}`)
      .expect(401);

    expect(response.body.success).toBe(false);
    expect(response.body.error.message).toBe("Invalid or expired token.");
  });

  it("accepts GET /api/v1/invoices with valid JWT token", async () => {
    mockInvoiceService.getInvoicesBySellerId.mockResolvedValue({
      invoices: [mockInvoice],
      total: 1,
    });

    const response = await request(app)
      .get("/api/v1/invoices")
      .set("Authorization", `Bearer ${validToken}`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveLength(1);
  });

  it("rejects GET /api/v1/invoices with no token", async () => {
    await request(app)
      .get("/api/v1/invoices")
      .expect(401);
  });
});
