import crypto from "crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { KycService } from "../../src/services/kyc.service";
import { createKycWebhookRouter } from "../../src/routes/kyc.routes";
import { KYCStatus, KYCVerificationType, NotificationType } from "../../src/types/enums";
import { HttpError } from "../../src/utils/http-error";
import type { NotificationService } from "../../src/services/notification.service";

interface UserRecord {
  id: string;
  stellarAddress: string;
  kycStatus: KYCStatus;
  isKycVerified: boolean;
}

interface VerificationRecord {
  id: string;
  userId: string;
  wallet: string | null;
  verificationType: KYCVerificationType;
  status: KYCStatus;
  documents: Record<string, unknown> | null;
  verifiedAt: Date | null;
}

interface HistoryRecord {
  userId: string;
  wallet: string | null;
  verificationType: KYCVerificationType;
  status: KYCStatus;
  documents: Record<string, unknown> | null;
  rejectionReason: string | null;
  providerReference: string | null;
  isArchived: boolean;
  archivedAt: Date;
}

const WEBHOOK_SECRET = "test-kyc-webhook-secret";

function signPayload(payload: Record<string, unknown>): { raw: string; signature: string } {
  const raw = JSON.stringify(payload);
  const digest = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return { raw, signature: `sha256=${digest}` };
}

function createTestHarness() {
  const users = new Map<string, UserRecord>([
    [
      "user-a",
      {
        id: "user-a",
        stellarAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        kycStatus: KYCStatus.PENDING,
        isKycVerified: false,
      },
    ],
    [
      "user-b",
      {
        id: "user-b",
        stellarAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQ7N",
        kycStatus: KYCStatus.PENDING,
        isKycVerified: false,
      },
    ],
  ]);

  const verifications = new Map<string, VerificationRecord>([
    [
      "ver-a",
      {
        id: "ver-a",
        userId: "user-a",
        wallet: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        verificationType: KYCVerificationType.IDENTITY,
        status: KYCStatus.PENDING,
        documents: { providerReference: "prov-ref-a" },
        verifiedAt: null,
      },
    ],
    [
      "ver-b",
      {
        id: "ver-b",
        userId: "user-b",
        wallet: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQ7N",
        verificationType: KYCVerificationType.IDENTITY,
        status: KYCStatus.PENDING,
        documents: { providerReference: "prov-ref-b" },
        verifiedAt: null,
      },
    ],
  ]);

  const history: HistoryRecord[] = [];

  const matchesWhere = <T extends Record<string, unknown>>(
    record: T,
    where: Record<string, unknown>
  ): boolean => Object.entries(where).every(([key, value]) => record[key] === value);

  const userRepository = {
    findOneBy: jest.fn(async (where: Record<string, unknown>) => {
      for (const user of users.values()) {
        if (matchesWhere(user as unknown as Record<string, unknown>, where)) {
          return { ...user };
        }
      }
      return null;
    }),
    update: jest.fn(async (id: string, patch: Partial<UserRecord>) => {
      const existing = users.get(id);
      if (existing) {
        users.set(id, { ...existing, ...patch });
      }
    }),
  };

  const verificationRepository = {
    findOneBy: jest.fn(async (where: Record<string, unknown>) => {
      for (const verification of verifications.values()) {
        if (matchesWhere(verification as unknown as Record<string, unknown>, where)) {
          return { ...verification };
        }
      }
      return null;
    }),
    findOne: jest.fn(async (options: { where: Record<string, unknown> }) => {
      for (const verification of verifications.values()) {
        if (matchesWhere(verification as unknown as Record<string, unknown>, options.where)) {
          return { ...verification };
        }
      }
      return null;
    }),
    save: jest.fn(async (entity: VerificationRecord) => {
      verifications.set(entity.id, { ...entity });
      return entity;
    }),
  };

  const historyRepository = {
    create: jest.fn((value: HistoryRecord) => ({ ...value })),
    save: jest.fn(async (value: HistoryRecord) => {
      history.push({ ...value });
      return value;
    }),
  };

  const manager = {
    getRepository: jest.fn((entity: { name: string }) => {
      if (entity.name === "User") return userRepository;
      if (entity.name === "KYCVerification") return verificationRepository;
      if (entity.name === "KycHistory") return historyRepository;
      throw new Error(`Unexpected repository: ${entity.name}`);
    }),
  };

  const dataSource = {
    transaction: jest.fn(async (callback: (mgr: typeof manager) => Promise<void>) =>
      callback(manager)
    ),
  };

  const appLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  const notificationService = {
    createNotification: jest.fn().mockResolvedValue(undefined),
  } as unknown as NotificationService & { createNotification: jest.Mock };

  const service = new KycService(
    dataSource as any,
    WEBHOOK_SECRET,
    appLogger as any,
    notificationService
  );

  const app = express();
  app.use("/api/v1/kyc", createKycWebhookRouter(service));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ error: { message: err.message } });
      return;
    }
    res.status(500).json({ error: { message: "Internal server error" } });
  });

  return {
    app,
    users,
    verifications,
    history,
    notificationService,
  };
}

describe("KYC webhook identity binding integration", () => {
  it("rejects pairing user A with user B's verification and preserves all records", async () => {
    const { app, users, verifications, history, notificationService } = createTestHarness();
    const { raw, signature } = signPayload({
      userId: "user-a",
      verificationId: "ver-b",
      status: KYCStatus.APPROVED,
    });

    const response = await request(app)
      .post("/api/v1/kyc/webhook")
      .set("Content-Type", "application/json")
      .set("x-provider-signature", signature)
      .send(raw);

    expect(response.status).toBe(404);
    expect(users.get("user-a")).toMatchObject({
      kycStatus: KYCStatus.PENDING,
      isKycVerified: false,
    });
    expect(users.get("user-b")).toMatchObject({
      kycStatus: KYCStatus.PENDING,
      isKycVerified: false,
    });
    expect(verifications.get("ver-a")).toMatchObject({
      status: KYCStatus.PENDING,
      verifiedAt: null,
    });
    expect(verifications.get("ver-b")).toMatchObject({
      status: KYCStatus.PENDING,
      verifiedAt: null,
    });
    expect(history).toHaveLength(0);
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  it("rejects wallet mismatch when payload wallet belongs to another user", async () => {
    const { app, users, verifications, history, notificationService } = createTestHarness();
    const { raw, signature } = signPayload({
      userId: "user-a",
      verificationId: "ver-a",
      wallet: users.get("user-b")!.stellarAddress,
      status: KYCStatus.APPROVED,
    });

    const response = await request(app)
      .post("/api/v1/kyc/webhook")
      .set("Content-Type", "application/json")
      .set("x-provider-signature", signature)
      .send(raw);

    expect(response.status).toBe(409);
    expect(users.get("user-a")).toMatchObject({
      kycStatus: KYCStatus.PENDING,
      isKycVerified: false,
    });
    expect(verifications.get("ver-a")).toMatchObject({
      status: KYCStatus.PENDING,
      verifiedAt: null,
    });
    expect(history).toHaveLength(0);
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  it("rejects providerReference mismatch when record carries a different reference", async () => {
    const { app, users, verifications, history, notificationService } = createTestHarness();
    const { raw, signature } = signPayload({
      userId: "user-a",
      verificationId: "ver-a",
      providerReference: "prov-ref-b",
      status: KYCStatus.APPROVED,
    });

    const response = await request(app)
      .post("/api/v1/kyc/webhook")
      .set("Content-Type", "application/json")
      .set("x-provider-signature", signature)
      .send(raw);

    expect(response.status).toBe(409);
    expect(users.get("user-a")).toMatchObject({
      kycStatus: KYCStatus.PENDING,
      isKycVerified: false,
    });
    expect(verifications.get("ver-a")).toMatchObject({
      status: KYCStatus.PENDING,
      verifiedAt: null,
    });
    expect(history).toHaveLength(0);
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown userId and unknown verificationId without side effects", async () => {
    const { app, history, notificationService } = createTestHarness();

    const unknownUser = signPayload({
      userId: "unknown-user",
      verificationId: "ver-a",
      status: KYCStatus.APPROVED,
    });
    const unknownUserRes = await request(app)
      .post("/api/v1/kyc/webhook")
      .set("Content-Type", "application/json")
      .set("x-provider-signature", unknownUser.signature)
      .send(unknownUser.raw);

    expect(unknownUserRes.status).toBe(404);

    const unknownVer = signPayload({
      userId: "user-a",
      verificationId: "unknown-ver",
      status: KYCStatus.APPROVED,
    });
    const unknownVerRes = await request(app)
      .post("/api/v1/kyc/webhook")
      .set("Content-Type", "application/json")
      .set("x-provider-signature", unknownVer.signature)
      .send(unknownVer.raw);

    expect(unknownVerRes.status).toBe(404);
    expect(history).toHaveLength(0);
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  it("processes correctly matched approval and rejection callbacks independently", async () => {
    const { app, users, verifications, history, notificationService } = createTestHarness();

    const approveUserA = signPayload({
      userId: "user-a",
      verificationId: "ver-a",
      wallet: users.get("user-a")!.stellarAddress,
      providerReference: "prov-ref-a",
      status: KYCStatus.APPROVED,
    });
    const approveRes = await request(app)
      .post("/api/v1/kyc/webhook")
      .set("Content-Type", "application/json")
      .set("x-provider-signature", approveUserA.signature)
      .send(approveUserA.raw);

    expect(approveRes.status).toBe(204);
    expect(users.get("user-a")).toMatchObject({
      kycStatus: KYCStatus.APPROVED,
      isKycVerified: true,
    });
    expect(verifications.get("ver-a")?.status).toBe(KYCStatus.APPROVED);
    expect(users.get("user-b")).toMatchObject({
      kycStatus: KYCStatus.PENDING,
      isKycVerified: false,
    });
    expect(verifications.get("ver-b")?.status).toBe(KYCStatus.PENDING);

    const rejectUserB = signPayload({
      userId: "user-b",
      verificationId: "ver-b",
      wallet: users.get("user-b")!.stellarAddress,
      providerReference: "prov-ref-b",
      status: KYCStatus.REJECTED,
      reason: "Document expired",
    });
    const rejectRes = await request(app)
      .post("/api/v1/kyc/webhook")
      .set("Content-Type", "application/json")
      .set("x-provider-signature", rejectUserB.signature)
      .send(rejectUserB.raw);

    expect(rejectRes.status).toBe(204);
    expect(users.get("user-b")).toMatchObject({
      kycStatus: KYCStatus.REJECTED,
      isKycVerified: false,
    });
    expect(verifications.get("ver-b")?.status).toBe(KYCStatus.REJECTED);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ userId: "user-a", providerReference: "prov-ref-a" });
    expect(history[1]).toMatchObject({
      userId: "user-b",
      providerReference: "prov-ref-b",
      rejectionReason: "Document expired",
    });
    expect(notificationService.createNotification).toHaveBeenCalledTimes(2);
    expect(notificationService.createNotification).toHaveBeenNthCalledWith(
      1,
      "user-a",
      NotificationType.KYC_APPROVED,
      "KYC Approved",
      expect.any(String),
      { status: KYCStatus.APPROVED, reason: null }
    );
    expect(notificationService.createNotification).toHaveBeenNthCalledWith(
      2,
      "user-b",
      NotificationType.KYC_REJECTED,
      "KYC Status Updated",
      expect.any(String),
      { status: KYCStatus.REJECTED, reason: "Document expired" }
    );
  });
});
