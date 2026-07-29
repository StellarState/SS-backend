import express from "express";
import request from "supertest";

import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { logger } from "../../src/observability/logger";
import { createInvoiceRouter } from "../../src/routes/invoice.routes";

describe("JWT authentication validation", () => {
  it("rejects invoice requests without an Authorization header", async () => {
    const invoiceService = {
      getInvoicesBySellerId: jest.fn(),
    };

    const app = express();
    app.use(express.json());
    app.use(
      "/api/v1/invoices",
      createInvoiceRouter({
        invoiceService: invoiceService as any,
        config: {
          ipfs: {
            maxFileSizeMB: 10,
            allowedMimeTypes: ["application/pdf"],
            uploadRateLimit: {
              windowMs: 60_000,
              maxUploads: 5,
            },
          },
          kyc: {
            skipVerification: true,
          },
        } as any,
      }),
    );
    app.use(createErrorMiddleware(logger));

    const response = await request(app).get("/api/v1/invoices").expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Authorization token is required.",
      },
    });
    expect(invoiceService.getInvoicesBySellerId).not.toHaveBeenCalled();
  });
});
