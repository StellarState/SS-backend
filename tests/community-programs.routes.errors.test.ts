import express from "express";
import request from "supertest";
import { DataSource } from "typeorm";
import { createErrorMiddleware } from "../src/middleware/error.middleware";
import { InvoiceFraudReport } from "../src/models/InvoiceFraudReport.model";
import { Referral } from "../src/models/Referral.model";
import { WaitlistEntry } from "../src/models/WaitlistEntry.model";
import { WaitlistReferralCredit } from "../src/models/WaitlistReferralCredit.model";
import { createCommunityProgramsRouter } from "../src/routes/community-programs.routes";
import type { AuthService } from "../src/services/auth.service";
import { logger } from "../src/observability/logger";
import { KYCStatus, UserType } from "../src/types/enums";
import type { PublicUser } from "../src/types/auth";

describe("Community programs typed route errors", () => {
  let app: express.Application;
  let dataSource: DataSource;

  const adminUser: PublicUser = {
    id: "admin-id",
    stellarAddress: "GADMIN",
    email: "admin@example.com",
    userType: UserType.ADMIN,
    kycStatus: KYCStatus.APPROVED,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const authService = {
    getCurrentUser: jest.fn().mockResolvedValue(adminUser),
  } as unknown as AuthService;
  const authorization = { Authorization: "Bearer test-token" };

  beforeAll(async () => {
    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [InvoiceFraudReport, Referral, WaitlistEntry, WaitlistReferralCredit],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
  });

  beforeEach(async () => {
    await dataSource.synchronize(true);
    app = express();
    app.use(express.json());
    app.use("/api/v1", createCommunityProgramsRouter(dataSource, authService));
    app.get("/test/unexpected", (_req, _res, next) => next(new Error("unexpected failure")));
    app.use(createErrorMiddleware(logger));
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it("returns a typed 400 for an invalid waitlist email", async () => {
    const response = await request(app)
      .post("/api/v1/waitlist")
      .send({ wallet: "GUSER", email: "not-an-email" })
      .expect(400);

    expect(response.body.error.code).toBe("COMMUNITY_PROGRAM_VALIDATION_ERROR");
  });

  it("returns a typed 409 for a duplicate fraud report", async () => {
    const report = {
      reason: "duplicate",
      detail: "same report",
    };
    const endpoint = "/api/v1/invoices/00000000-0000-4000-8000-000000000001/reports";

    await request(app).post(endpoint).set(authorization).send(report).expect(201);
    const response = await request(app).post(endpoint).set(authorization).send(report).expect(409);

    expect(response.body.error.code).toBe("FRAUD_REPORT_DUPLICATE");
  });

  it("returns typed 404 errors for missing fraud reports and waitlist entries", async () => {
    const reportResponse = await request(app)
      .patch("/api/v1/admin/reports/missing-report")
      .set(authorization)
      .send({ status: "resolved" })
      .expect(404);
    const waitlistResponse = await request(app)
      .post("/api/v1/admin/waitlist/GUNKNOWN/approve")
      .set(authorization)
      .expect(404);

    expect(reportResponse.body.error.code).toBe("FRAUD_REPORT_NOT_FOUND");
    expect(waitlistResponse.body.error.code).toBe("WAITLIST_ENTRY_NOT_FOUND");
  });

  it("returns a typed 409 when a referral claim has no available rewards", async () => {
    const response = await request(app)
      .post("/api/v1/referrals/claim")
      .set(authorization)
      .send({})
      .expect(409);

    expect(response.body.error.code).toBe("REFERRAL_CLAIM_UNAVAILABLE");
    expect(response.body.error.message).toBe("No referral rewards are available to claim");
  });

  it("keeps unexpected exceptions on the generic 500 response path", async () => {
    const response = await request(app).get("/test/unexpected").expect(500);

    expect(response.body).toEqual({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error.",
      },
    });
  });
});
