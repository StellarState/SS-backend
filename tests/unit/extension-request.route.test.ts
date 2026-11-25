import express from "express";
import request from "supertest";
import { createInvoiceRouter } from "../../src/routes/invoice.routes";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { logger } from "../../src/observability/logger";
import { ExtensionRequestStatus, UserType } from "../../src/types/enums";

/** POST /api/v1/invoices/:id/extension-request input parsing (issue #733). */
describe("POST /api/v1/invoices/:id/extension-request", () => {
  let requestExtension: jest.Mock;
  let app: express.Application;

  beforeEach(() => {
    requestExtension = jest.fn(async (input: { proposedDeadline: Date }) => ({
      id: "req-1",
      invoiceId: "inv-1",
      proposedDeadline: input.proposedDeadline,
      previousDeadline: null,
      status: ExtensionRequestStatus.PENDING,
      reason: null,
      createdAt: new Date("2026-06-01T00:00:00Z"),
    }));
    app = express();
    app.use(express.json());
    app.use(
      "/api/v1/invoices",
      createInvoiceRouter({
        invoiceService: {} as never,
        config: {
          ipfs: {
            maxFileSizeMB: 10,
            allowedMimeTypes: [],
            uploadRateLimit: { windowMs: 1000, maxUploads: 1 },
          },
          kyc: { skipVerification: true },
        } as never,
        authService: {
          getCurrentUser: jest.fn(async () => ({
            id: "seller-1",
            stellarAddress: "GSELLER",
            userType: UserType.SELLER,
          })),
        } as never,
        extensionService: { requestExtension } as never,
      })
    );
    app.use(createErrorMiddleware(logger));
  });

  const submit = (proposedDeadline: unknown) =>
    request(app)
      .post("/api/v1/invoices/inv-1/extension-request")
      .set("Authorization", "Bearer token")
      .send({ proposedDeadline });

  it("reads a bare date as the end of that UTC day, like invoice maturity", async () => {
    const res = await submit("2026-07-01");
    expect(res.status).toBe(201);
    expect(requestExtension.mock.calls[0][0].proposedDeadline).toEqual(
      new Date("2026-07-01T23:59:59.999Z")
    );
    expect(res.body.data.proposedDeadline).toBe("2026-07-01T23:59:59.999Z");
  });

  it("takes a timestamp with an offset as the instant it names", async () => {
    await submit("2026-07-01T21:00:00-05:00");
    expect(requestExtension.mock.calls[0][0].proposedDeadline).toEqual(
      new Date("2026-07-02T02:00:00.000Z")
    );
  });

  it("requires proposedDeadline", async () => {
    const res = await submit(undefined);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_FIELDS");
    expect(requestExtension).not.toHaveBeenCalled();
  });
});
