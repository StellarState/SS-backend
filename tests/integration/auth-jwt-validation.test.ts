import request from "supertest";
import express from "express";
import { createInvoiceRouter } from "../../src/routes/invoice.routes";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { logger } from "../../src/observability/logger";

describe("Auth JWT Validation", () => {
  let app: express.Application;
  let mockInvoiceService: any;

  const mockConfig = {
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
    kyc: {
      skipVerification: true,
    },
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
        config: mockConfig as any,
      })
    );
    app.use(createErrorMiddleware(logger));
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it("returns 401 when Authorization header is missing on GET /api/v1/invoices", async () => {
    const response = await request(app).get("/api/v1/invoices").expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Authorization token is required.",
      },
    });
  });

  it("returns 401 when Authorization header is missing on POST /api/v1/invoices", async () => {
    await request(app)
      .post("/api/v1/invoices")
      .send({
        invoiceNumber: "INV-001",
        customerName: "Test Customer",
        amount: "1000.00",
        discountRate: "10.00",
        dueDate: "2024-12-31",
      })
      .expect(401);
  });

  it("returns 401 when Authorization header is missing on GET /api/v1/invoices/:id", async () => {
    await request(app).get("/api/v1/invoices/invoice-123").expect(401);
  });

  it("returns 401 when Authorization header is missing on PUT /api/v1/invoices/:id", async () => {
    await request(app)
      .put("/api/v1/invoices/invoice-123")
      .send({ customerName: "Updated Name" })
      .expect(401);
  });

  it("returns 401 when Authorization header is missing on DELETE /api/v1/invoices/:id", async () => {
    await request(app).delete("/api/v1/invoices/invoice-123").expect(401);
  });

  it("returns 401 when Authorization header is missing on POST /api/v1/invoices/:id/publish", async () => {
    await request(app).post("/api/v1/invoices/invoice-123/publish").expect(401);
  });

  it("returns 401 when Authorization header is missing on POST /api/v1/invoices/:id/document", async () => {
    await request(app)
      .post("/api/v1/invoices/invoice-123/document")
      .attach("document", Buffer.from("test pdf content"), "test.pdf")
      .expect(401);
  });
});
