import crypto from "crypto";
import { KycService } from "../src/services/kyc.service";
import { KYCVerification } from "../src/models/KYCVerification.model";
import { KycHistory } from "../src/models/KycHistory.model";
import { KycWebhookEvent } from "../src/models/KycWebhookEvent.model";
import { User } from "../src/models/User.model";
import { KYCStatus, KYCVerificationType, NotificationType } from "../src/types/enums";
import type { NotificationService } from "../src/services/notification.service";

function createHarness(notificationService?: NotificationService) {
  let eventRecord: Record<string, any> | undefined;
  const user = { id: "user-1" };
  const verification = {
    id: "verification-1",
    userId: user.id,
    verificationType: KYCVerificationType.IDENTITY,
    status: KYCStatus.PENDING,
    documents: null,
    verifiedAt: null as Date | null,
  };
  const userRepository = {
    findOneBy: jest.fn().mockResolvedValue(user),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const verificationRepository = {
    create: jest.fn((value) => ({ ...verification, ...value })),
    save: jest.fn(async (value) => value),
    findOneBy: jest.fn().mockResolvedValue(verification),
    findOne: jest.fn().mockResolvedValue(verification),
  };
  const historyRepository = {
    create: jest.fn((value) => ({ ...value })),
    save: jest.fn(async (value) => value),
  };
  const eventRepository = {
    createQueryBuilder: jest.fn(() => {
      let operation: "insert" | "update" | undefined;
      let values: Record<string, any> = {};
      let parameters: Record<string, any> = {};
      let builder: any;
      builder = {
        insert: jest.fn(() => {
          operation = "insert";
          return builder;
        }),
        into: jest.fn(() => builder),
        values: jest.fn((value) => {
          values = value;
          return builder;
        }),
        orIgnore: jest.fn(() => builder),
        update: jest.fn(() => {
          operation = "update";
          return builder;
        }),
        set: jest.fn((value) => {
          values = value;
          return builder;
        }),
        where: jest.fn((_condition, value) => {
          parameters = value;
          return builder;
        }),
        execute: jest.fn(async () => {
          if (operation === "insert") {
            if (!eventRecord) eventRecord = { ...values };
            return { affected: eventRecord ? 1 : 0 };
          }
          if (
            !eventRecord ||
            eventRecord.provider !== parameters.provider ||
            eventRecord.eventId !== parameters.eventId ||
            eventRecord.status === "succeeded" ||
            (eventRecord.status === "processing" &&
              eventRecord.processingStartedAt > parameters.expiredBefore)
          ) {
            return { affected: 0 };
          }
          eventRecord = {
            ...eventRecord,
            ...values,
            attemptCount: eventRecord.attemptCount + 1,
          };
          return { affected: 1 };
        }),
      };
      return builder;
    }),
    findOneBy: jest.fn(async (where) =>
      eventRecord &&
      eventRecord.provider === where.provider &&
      eventRecord.eventId === where.eventId
        ? eventRecord
        : null
    ),
    update: jest.fn(async (where, values) => {
      if (
        !eventRecord ||
        eventRecord.provider !== where.provider ||
        eventRecord.eventId !== where.eventId ||
        eventRecord.status !== where.status
      ) {
        return { affected: 0 };
      }
      eventRecord = { ...eventRecord, ...values };
      return { affected: 1 };
    }),
  };
  const manager = {
    getRepository: jest.fn((entity) => {
      if (entity === User) return userRepository;
      if (entity === KYCVerification) return verificationRepository;
      if (entity === KycHistory) return historyRepository;
      if (entity === KycWebhookEvent) return eventRepository;
      return verificationRepository;
    }),
  };
  const dataSource = {
    transaction: jest.fn(async (callback) => callback(manager)),
    getRepository: jest.fn(() => eventRepository),
  };
  const appLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };
  const service = new KycService(
    dataSource as any,
    "webhook-secret",
    appLogger as any,
    notificationService
  );
  return {
    service,
    userRepository,
    verificationRepository,
    historyRepository,
    eventRepository,
    getEventRecord: () => eventRecord,
    appLogger,
  };
}

describe("KycService", () => {
  it("submits a verification and moves the user to pending", async () => {
    const { service, userRepository, verificationRepository } = createHarness();
    const result = await service.submitKycVerification("user-1", {
      providerReference: "provider-123",
    });
    expect(result.status).toBe(KYCStatus.PENDING);
    expect(verificationRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationType: KYCVerificationType.IDENTITY,
        documents: { providerReference: "provider-123" },
      })
    );
    expect(userRepository.update).toHaveBeenCalledWith("user-1", {
      kycStatus: KYCStatus.PENDING,
      isKycVerified: false,
    });
  });

  it("validates HMAC signatures using the raw body", () => {
    const { service } = createHarness();
    const body = Buffer.from('{"userId":"user-1"}');
    const signature = crypto.createHmac("sha256", "webhook-secret").update(body).digest("hex");
    expect(service.verifyWebhookSignature(body, `sha256=${signature}`)).toBe(true);
    expect(service.verifyWebhookSignature(body, "sha256=deadbeef")).toBe(false);
  });

  it.each([
    [KYCStatus.APPROVED, true],
    [KYCStatus.REJECTED, false],
  ])("processes %s webhook transitions", async (status, isKycVerified) => {
    const { service, userRepository, verificationRepository, appLogger } = createHarness();
    await service.processWebhook({ userId: "user-1", status });
    expect(verificationRepository.save).toHaveBeenCalledWith(expect.objectContaining({ status }));
    expect(userRepository.update).toHaveBeenCalledWith("user-1", {
      kycStatus: status,
      isKycVerified,
    });
    expect(appLogger.info).toHaveBeenCalledWith(
      "kyc.webhook.processed",
      expect.objectContaining({ status })
    );
  });

  it("persists event outcomes and skips business side effects for duplicate events", async () => {
    const notificationService = {
      createNotification: jest.fn().mockResolvedValue(undefined),
    } as unknown as NotificationService;
    const { service, verificationRepository, historyRepository, getEventRecord } =
      createHarness(notificationService);
    const payload = {
      eventId: "provider-event-1",
      userId: "user-1",
      status: KYCStatus.APPROVED,
    };

    await service.processWebhook(payload);
    await service.processWebhook(payload);

    expect(getEventRecord()).toMatchObject({
      provider: "kyc",
      eventId: "provider-event-1",
      status: "succeeded",
      attemptCount: 1,
      failureKind: null,
    });
    expect(verificationRepository.save).toHaveBeenCalledTimes(1);
    expect(historyRepository.save).toHaveBeenCalledTimes(1);
    expect(notificationService.createNotification).toHaveBeenCalledTimes(1);
  });

  it("persists permanent validation failures for operator visibility", async () => {
    const { service, getEventRecord } = createHarness();

    await expect(
      service.processWebhook({
        eventId: "invalid-event",
        userId: "user-1",
        status: KYCStatus.PENDING,
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(getEventRecord()).toMatchObject({
      eventId: "invalid-event",
      status: "failed",
      failureKind: "permanent",
      errorMessage: "Webhook status must be approved or rejected.",
    });
  });

  it("reclaims a failed event on retry and completes it", async () => {
    const { service, userRepository, getEventRecord } = createHarness();
    userRepository.findOneBy
      .mockRejectedValueOnce(new Error("temporary database outage"))
      .mockResolvedValueOnce({ id: "user-1" });
    const payload = {
      eventId: "retryable-event",
      userId: "user-1",
      status: KYCStatus.APPROVED,
    };

    await expect(service.processWebhook(payload)).rejects.toThrow("temporary database outage");
    expect(getEventRecord()).toMatchObject({
      status: "failed",
      failureKind: "retryable",
      attemptCount: 1,
    });

    await service.processWebhook(payload);
    expect(getEventRecord()).toMatchObject({
      status: "succeeded",
      failureKind: null,
      attemptCount: 2,
    });
  });

  it("rejects unsupported webhook transitions", async () => {
    const { service } = createHarness();
    await expect(
      service.processWebhook({ userId: "user-1", status: KYCStatus.PENDING })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("KycService — notification paths", () => {
  function buildNotificationService(
    overrides: Partial<{ createNotification: jest.Mock }> = {}
  ): NotificationService {
    return {
      createNotification: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as NotificationService;
  }

  it.each([
    [KYCStatus.APPROVED, NotificationType.KYC_APPROVED, "KYC Approved"],
    [KYCStatus.REJECTED, NotificationType.KYC_REJECTED, "KYC Status Updated"],
  ] as const)(
    "calls createNotification with correct type/title for %s webhook",
    async (status, expectedType, expectedTitle) => {
      const notificationService = buildNotificationService();
      const { service } = createHarness(notificationService);

      await service.processWebhook({ userId: "user-1", status });

      expect(notificationService.createNotification).toHaveBeenCalledWith(
        "user-1",
        expectedType,
        expectedTitle,
        expect.any(String),
        expect.objectContaining({ status })
      );
    }
  );

  it("does not call createNotification when no notificationService is provided", async () => {
    const { service } = createHarness();
    // processWebhook must not throw even without a notification service
    await expect(
      service.processWebhook({ userId: "user-1", status: KYCStatus.APPROVED })
    ).resolves.toBeUndefined();
  });

  it("swallows createNotification errors and logs a warning", async () => {
    const notificationService = buildNotificationService({
      createNotification: jest.fn().mockRejectedValue(new Error("db down")),
    });
    const { service, appLogger } = createHarness(notificationService);

    // processWebhook must still resolve successfully
    await expect(
      service.processWebhook({ userId: "user-1", status: KYCStatus.APPROVED })
    ).resolves.toBeUndefined();

    expect(appLogger.warn).toHaveBeenCalledWith(
      "kyc.notification.failed",
      expect.objectContaining({ user_id: "user-1" })
    );
  });
});
