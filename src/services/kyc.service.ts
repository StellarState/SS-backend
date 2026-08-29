import crypto from "crypto";
import { DataSource } from "typeorm";
import { KYCVerification } from "../models/KYCVerification.model";
import { User } from "../models/User.model";
import { KYCStatus, KYCVerificationType } from "../types/enums";
import { HttpError } from "../utils/http-error";
import { logger, type AppLogger } from "../observability/logger";

export interface KycProviderData {
  verificationType?: KYCVerificationType;
  documents?: Record<string, unknown>;
  providerReference?: string;
}

export interface KycWebhookPayload {
  userId: string;
  status: KYCStatus;
  verificationId?: string;
  providerReference?: string;
  reason?: string;
}

export class KycService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly webhookSecret: string,
    private readonly appLogger: AppLogger = logger,
  ) {}

  async submitKycVerification(userId: string, providerData: KycProviderData = {}): Promise<KYCVerification> {
    return this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(User).findOneBy({ id: userId });
      if (!user) throw new HttpError(404, "User not found.");

      const repository = manager.getRepository(KYCVerification);
      const verification = repository.create({
        userId,
        verificationType: providerData.verificationType ?? KYCVerificationType.IDENTITY,
        status: KYCStatus.PENDING,
        documents: providerData.documents ?? (providerData.providerReference ? { providerReference: providerData.providerReference } : null),
      });
      const saved = await repository.save(verification);
      await manager.getRepository(User).update(userId, { kycStatus: KYCStatus.PENDING, isKycVerified: false });
      return saved;
    });
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature || !this.webhookSecret) return false;
    const supplied = signature.replace(/^sha256=/, "");
    const expected = crypto.createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    const suppliedBuffer = Buffer.from(supplied, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    return suppliedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
  }

  async processWebhook(payload: KycWebhookPayload): Promise<void> {
    if (!payload || typeof payload.userId !== "string") {
      throw new HttpError(400, "Webhook userId is required.");
    }
    if (![KYCStatus.APPROVED, KYCStatus.REJECTED].includes(payload.status)) {
      throw new HttpError(400, "Webhook status must be approved or rejected.");
    }

    await this.dataSource.transaction(async (manager) => {
      const userRepository = manager.getRepository(User);
      const verificationRepository = manager.getRepository(KYCVerification);
      const user = await userRepository.findOneBy({ id: payload.userId });
      if (!user) throw new HttpError(404, "User not found.");

      const verification = payload.verificationId
        ? await verificationRepository.findOneBy({ id: payload.verificationId })
        : await verificationRepository.findOne({
            where: { userId: payload.userId, status: KYCStatus.PENDING },
          });
      if (!verification) throw new HttpError(404, "KYC verification not found.");

      verification.status = payload.status;
      verification.verifiedAt = new Date();
      await verificationRepository.save(verification);
      await userRepository.update(payload.userId, {
        kycStatus: payload.status,
        isKycVerified: payload.status === KYCStatus.APPROVED,
      });
      this.appLogger.info("kyc.webhook.processed", {
        user_id: payload.userId,
        verification_id: verification.id,
        status: payload.status,
        reason: payload.reason ?? null,
      });
    });
  }
}
