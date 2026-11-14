import express from "express";
import request from "supertest";
import type { DataSource } from "typeorm";
import { createCommunityProgramsRouter } from "../../src/routes/community-programs.routes";
import { COMMUNITY_PROGRAM_ERROR_CODES } from "../../src/services/community-programs.service";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { FraudReportStatus, InvoiceFraudReport } from "../../src/models/InvoiceFraudReport.model";
import { Referral } from "../../src/models/Referral.model";
import { WaitlistEntry } from "../../src/models/WaitlistEntry.model";
import type { AuthService } from "../../src/services/auth.service";
import type { AppLogger } from "../../src/observability/logger";
import type { AuthenticatedRequestUser } from "../../src/types/auth";
import { KYCStatus, UserType } from "../../src/types/enums";

const INVESTOR_WALLET = "GINVESTORWALLET1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ23456";
const ADMIN_WALLET = "GADMINWALLET1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function createTestLogger(): AppLogger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as AppLogger;
}

function makeUser(stellarAddress: string, userType: UserType): AuthenticatedRequestUser {
  const now = new Date("2026-11-14T00:00:00.000Z");
  return {
    id: `user-${stellarAddress.slice(0, 8)}`,
    stellarAddress,
    email: null,
    userType,
    kycStatus: KYCStatus.APPROVED,
    isKycVerified: true,
    isSuspended: false,
    createdAt: now,
    updatedAt: now,
  };
}

function createHarness() {
  const fraudReportRepo = {
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    findAndCount: jest.fn(),
    create: jest.fn((input: Partial<InvoiceFraudReport>) => input),
    save: jest.fn(async (entity: Partial<InvoiceFraudReport>) => ({
      id: "report-1",
      ...entity,
    })),
  };

  const referralRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((input: Partial<Referral>) => input),
    save: jest.fn(async (entity: Partial<Referral>) => ({
      id: "referral-1",
      ...entity,
    })),
  };

  const waitlistRepo = {
    findOne: jest.fn(),
    count: jest.fn().mockResolvedValue(1),
    increment: jest.fn().mockResolvedValue({ affected: 1 }),
    create: jest.fn((input: Partial<WaitlistEntry>) => input),
    save: jest.fn(async (entity: Partial<WaitlistEntry>) => ({
      id: "waitlist-1",
      ...entity,
    })),
  };

  const dataSource = {
    getRepository: jest.fn((entity: unknown) => {
      if (entity === InvoiceFraudReport) return fraudReportRepo;
      if (entity === Referral) return referralRepo;
      if (entity === WaitlistEntry) return waitlistRepo;
      throw new Error(`Unexpected repository requested: ${String(entity)}`);
    }),
  } as unknown as DataSource;

  const authService = {
    getCurrentUser: jest.fn(async (token: string) => {
      if (token === "admin-token") {
        return makeUser(ADMIN_WALLET, UserType.ADMIN);
      }
      return makeUser(INVESTOR_WALLET, UserType.INVESTOR);
    }),
  } as unknown as AuthService;

  const logger = createTestLogger();
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createCommunityProgramsRouter(dataSource, authService));
  app.use(createErrorMiddleware(logger));

  return {
    app,
    logger,
    fraudReportRepo,
    referralRepo,
    waitlistRepo,
  };
}

describe("Community programmes HTTP error translation (#711)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns 400 with INVALID_WAITLIST_REGISTRATION for an invalid waitlist email", async () => {
    const { app, waitlistRepo } = createHarness();

    const response = await request(app)
      .post("/api/v1/waitlist")
      .send({ wallet: INVESTOR_WALLET, email: "not-a-valid-email" })
      .expect(400);

    expect(response.body).toEqual({
      success: false,
      error: {
        code: COMMUNITY_PROGRAM_ERROR_CODES.INVALID_WAITLIST_REGISTRATION,
        message: "A valid wallet and email are required",
      },
    });
    expect(waitlistRepo.findOne).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid fraud report payloads and 409 with DUPLICATE_FRAUD_REPORT for duplicate reports", async () => {
    const { app, fraudReportRepo } = createHarness();

    const invalidRes = await request(app)
      .post("/api/v1/invoices/inv-1/reports")
      .set("Authorization", "Bearer investor-token")
      .send({ reason: "", detail: "Missing reason" })
      .expect(400);

    expect(invalidRes.body).toEqual({
      success: false,
      error: {
        code: COMMUNITY_PROGRAM_ERROR_CODES.INVALID_FRAUD_REPORT,
        message: "reason and detail are required and must be within the allowed length",
      },
    });

    fraudReportRepo.findOne.mockResolvedValueOnce({
      id: "existing-report",
      invoiceId: "inv-1",
      reporterWallet: INVESTOR_WALLET,
      status: FraudReportStatus.OPEN,
    });

    const duplicateRes = await request(app)
      .post("/api/v1/invoices/inv-1/reports")
      .set("Authorization", "Bearer investor-token")
      .send({ reason: "duplicate_invoice", detail: "Invoice appears duplicated across issuers." })
      .expect(409);

    expect(duplicateRes.body).toEqual({
      success: false,
      error: {
        code: COMMUNITY_PROGRAM_ERROR_CODES.DUPLICATE_FRAUD_REPORT,
        message: "A report already exists for this wallet and invoice",
      },
    });
  });

  it("returns 400 for invalid referral registration or invalid fraud report review status", async () => {
    const { app } = createHarness();

    const selfReferralRes = await request(app)
      .post("/api/v1/referrals/register")
      .set("Authorization", "Bearer investor-token")
      .send({ referrerWallet: INVESTOR_WALLET })
      .expect(400);

    expect(selfReferralRes.body).toEqual({
      success: false,
      error: {
        code: COMMUNITY_PROGRAM_ERROR_CODES.INVALID_REFERRAL,
        message: "A referral must link two different wallets",
      },
    });

    const invalidStatusRes = await request(app)
      .patch("/api/v1/admin/reports/report-1")
      .set("Authorization", "Bearer admin-token")
      .send({ status: "open" })
      .expect(400);

    expect(invalidStatusRes.body).toEqual({
      success: false,
      error: {
        code: COMMUNITY_PROGRAM_ERROR_CODES.INVALID_FRAUD_REPORT_STATUS,
        message: "Invalid report status",
      },
    });
  });

  it("returns 404 for unknown fraud reports and unknown waitlist entries", async () => {
    const { app, fraudReportRepo, waitlistRepo } = createHarness();

    fraudReportRepo.findOneBy.mockResolvedValueOnce(null);

    const missingReportRes = await request(app)
      .patch("/api/v1/admin/reports/nonexistent-report")
      .set("Authorization", "Bearer admin-token")
      .send({ status: FraudReportStatus.INVESTIGATING })
      .expect(404);

    expect(missingReportRes.body).toEqual({
      success: false,
      error: {
        code: COMMUNITY_PROGRAM_ERROR_CODES.FRAUD_REPORT_NOT_FOUND,
        message: "Fraud report not found",
      },
    });

    waitlistRepo.findOne.mockResolvedValueOnce(null);

    const missingApproveRes = await request(app)
      .post("/api/v1/admin/waitlist/GUNKNOWNWALLET/approve")
      .set("Authorization", "Bearer admin-token")
      .expect(404);

    expect(missingApproveRes.body).toEqual({
      success: false,
      error: {
        code: COMMUNITY_PROGRAM_ERROR_CODES.WAITLIST_ENTRY_NOT_FOUND,
        message: "Waitlist entry not found",
      },
    });

    waitlistRepo.findOne.mockResolvedValueOnce(null);

    const missingLookupRes = await request(app).get("/api/v1/waitlist/GUNKNOWNWALLET").expect(404);

    expect(missingLookupRes.body).toEqual({
      success: false,
      error: {
        code: COMMUNITY_PROGRAM_ERROR_CODES.WAITLIST_ENTRY_NOT_FOUND,
        message: "Waitlist entry not found",
      },
    });
  });

  it("returns 409 with NO_AVAILABLE_REFERRAL_REWARDS when claiming with zero pending rewards", async () => {
    const { app, referralRepo } = createHarness();

    referralRepo.find.mockResolvedValueOnce([
      {
        id: "ref-1",
        referrerWallet: INVESTOR_WALLET,
        refereeWallet: ADMIN_WALLET,
        earnedAmount: "25.0000",
        claimedAmount: "25.0000",
        createdAt: new Date("2026-11-14T00:00:00.000Z"),
      },
    ]);

    const response = await request(app)
      .post("/api/v1/referrals/claim")
      .set("Authorization", "Bearer investor-token")
      .expect(409);

    expect(response.body).toEqual({
      success: false,
      error: {
        code: COMMUNITY_PROGRAM_ERROR_CODES.NO_AVAILABLE_REFERRAL_REWARDS,
        message: "No referral rewards are available to claim",
      },
    });
  });

  it("maps unexpected repository exceptions to generic 500 INTERNAL_ERROR via createErrorMiddleware", async () => {
    const { app, logger, waitlistRepo } = createHarness();

    waitlistRepo.findOne.mockRejectedValueOnce(new Error("SQLITE_IOERR: disk I/O error"));

    const response = await request(app)
      .post("/api/v1/waitlist")
      .send({ wallet: INVESTOR_WALLET, email: "investor@example.com" })
      .expect(500);

    expect(response.body).toEqual({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error.",
      },
    });
    expect(logger.error).toHaveBeenCalledWith(
      "Unhandled request error.",
      expect.objectContaining({
        statusCode: 500,
        error: "SQLITE_IOERR: disk I/O error",
      })
    );
  });
});
