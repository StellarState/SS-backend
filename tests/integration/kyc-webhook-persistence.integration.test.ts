import "reflect-metadata";
import { DataSource, getMetadataArgsStorage, type EntityManager } from "typeorm";
import { KycWebhookEvent } from "../../src/models/KycWebhookEvent.model";
import { KYCVerification } from "../../src/models/KYCVerification.model";
import { KycHistory } from "../../src/models/KycHistory.model";
import { User } from "../../src/models/User.model";
import { KycService } from "../../src/services/kyc.service";
import { KYCStatus, KYCVerificationType } from "../../src/types/enums";
import type { AppLogger } from "../../src/observability/logger";

function patchWebhookEventMetadataForSQLite(): void {
  for (const column of getMetadataArgsStorage().columns) {
    if (column.target !== KycWebhookEvent) continue;
    if (column.options.type === "timestamptz") column.options.type = "datetime" as any;
    if (column.options.type === "jsonb") column.options.type = "simple-json" as any;
    if (column.propertyName === "receivedAt") column.options.default = undefined;
  }
}

describe("KYC webhook event persistence", () => {
  let database: DataSource;
  let historySave: jest.Mock;
  let verificationSave: jest.Mock;
  let userUpdate: jest.Mock;
  let notification: jest.Mock;

  beforeAll(async () => {
    patchWebhookEventMetadataForSQLite();
    database = new DataSource({
      type: "sqlite",
      database: ":memory:",
      synchronize: true,
      entities: [KycWebhookEvent],
    });
    await database.initialize();
  });

  beforeEach(() => {
    historySave = jest.fn(async (value) => value);
    verificationSave = jest.fn(async (value) => value);
    userUpdate = jest.fn().mockResolvedValue(undefined);
    notification = jest.fn().mockResolvedValue(undefined);
  });

  afterAll(async () => {
    if (database?.isInitialized) await database.destroy();
  });

  it("persists success and avoids repeating KYC side effects on a duplicate delivery", async () => {
    const verification = {
      id: "verification-1",
      userId: "user-1",
      verificationType: KYCVerificationType.IDENTITY,
      status: KYCStatus.PENDING,
      documents: null,
      wallet: null,
      verifiedAt: null as Date | null,
    };
    const userRepository = {
      findOneBy: jest.fn().mockResolvedValue({ id: "user-1" }),
      update: userUpdate,
    };
    const verificationRepository = {
      findOne: jest.fn().mockResolvedValue(verification),
      findOneBy: jest.fn().mockResolvedValue(verification),
      save: verificationSave,
    };
    const historyRepository = {
      create: jest.fn((value) => value),
      save: historySave,
    };
    const logger: AppLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn(),
    };
    const repositories = (manager: EntityManager) => ({
      getRepository: (entity: Function) => {
        if (entity === KycWebhookEvent) return manager.getRepository(KycWebhookEvent);
        if (entity === User) return userRepository;
        if (entity === KYCVerification) return verificationRepository;
        if (entity === KycHistory) return historyRepository;
        throw new Error(`Unexpected repository: ${entity.name}`);
      },
    });
    const service = new KycService(
      {
        getRepository: (entity: Function) => database.getRepository(entity as never),
        transaction: (callback: (manager: unknown) => Promise<unknown>) =>
          database.transaction((manager) => callback(repositories(manager))),
      } as unknown as DataSource,
      "webhook-secret",
      logger,
      { createNotification: notification } as any
    );
    const payload = {
      eventId: "provider-event-1",
      userId: "user-1",
      status: KYCStatus.APPROVED,
    };

    await service.processWebhook(payload);
    await service.processWebhook(payload);

    const stored = await database
      .getRepository(KycWebhookEvent)
      .findOneByOrFail({ provider: "kyc", eventId: "provider-event-1" });
    expect(stored).toMatchObject({
      status: "succeeded",
      attemptCount: 1,
      failureKind: null,
    });
    expect(verificationSave).toHaveBeenCalledTimes(1);
    expect(historySave).toHaveBeenCalledTimes(1);
    expect(userUpdate).toHaveBeenCalledTimes(1);
    expect(notification).toHaveBeenCalledTimes(1);
  });
});
