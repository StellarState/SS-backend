import express from "express";
import request from "supertest";
import { createAdminRouter } from "../../src/routes/admin/admin.routes";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { logger } from "../../src/observability/logger";
import { ServiceError } from "../../src/utils/service-error";

/**
 * The admin extension review route used to pass ServiceErrors straight to the
 * error middleware, which only understands AppError/HttpError, so every
 * domain outcome (not found, already reviewed, and the #733 deadline checks)
 * came back as 500 INTERNAL_ERROR.
 */
describe("POST /api/v1/admin/invoices/:invoiceId/extensions/:requestId/review", () => {
  const ADMIN_KEY = "admin-extension-review-test-key";
  let reviewExtension: jest.Mock;
  let app: express.Application;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    reviewExtension = jest.fn();
    app = express();
    app.use(express.json());
    app.use(
      "/api/v1/admin",
      createAdminRouter({
        dataSource: {} as never,
        allowedCidrs: [],
        authService: { getCurrentUser: jest.fn() } as never,
        extensionService: { reviewExtension } as never,
      })
    );
    app.use(createErrorMiddleware(logger));
  });

  const review = (decision = "approve") =>
    request(app)
      .post("/api/v1/admin/invoices/inv-1/extensions/req-1/review")
      .set("x-admin-key", ADMIN_KEY)
      .send({ decision });

  it.each([
    [new ServiceError("EXTENSION_EXPIRED", "The proposed deadline passed", 409), 409],
    [new ServiceError("EXTENSION_BEYOND_MATURITY", "Beyond maturity", 422), 422],
    [new ServiceError("EXTENSION_DEADLINE_NOT_LATER", "Not later", 422), 422],
    [new ServiceError("EXTENSION_NOT_PENDING", "Already approved", 409), 409],
    [new ServiceError("EXTENSION_NOT_FOUND", "Extension request not found", 404), 404],
  ])("returns %p as its own status and code, not 500", async (error, status) => {
    reviewExtension.mockRejectedValue(error);

    const res = await review();

    expect(res.status).toBe(status);
    expect(res.body).toEqual({
      success: false,
      error: { code: error.code, message: error.message },
    });
  });

  it("still returns 500 for unexpected errors", async () => {
    reviewExtension.mockRejectedValue(new Error("connection reset"));
    const res = await review();
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });

  it("keeps the error details", async () => {
    reviewExtension.mockRejectedValue(
      new ServiceError("EXTENSION_BEYOND_MATURITY", "Beyond maturity", 422, {
        maturityCutoff: "2026-07-01T23:59:59.999Z",
      })
    );
    const res = await review();
    expect(res.body.error.details).toEqual({ maturityCutoff: "2026-07-01T23:59:59.999Z" });
  });
});
