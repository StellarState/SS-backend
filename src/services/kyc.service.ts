import crypto from "crypto";
import { DataSource, EntityManager, In, QueryFailedError } from "typeorm";
import { KYCVerification } from "../models/KYCVerification.model";
import { KycHistory } from "../models/KycHistory.model";
import { KycWebhookEvent } from "../models/KycWebhookEvent.model";
import { User } from "../models/User.model";
import { KYCStatus, KYCVerificationType, NotificationType } from "../types/enums";
import { HttpError } from "../utils/http-error";
import { logger, type AppLogger } from "../observability/logger";
import type { NotificationService } from "./notification.service";
import { logKYCStatusChange } from "../lib/kyc-status-log";

export interface KycProviderData {
  verificationType?: KYCVerificationType;
  documents?: Record<string, unknown>;
  providerReference?: string;
}

export interface KycWebhookPayload {
  userId: string;
  status: KYCStatus;
  eventId?: string;
  id?: string;
  verificationId?: string;
  /** Optional wallet binding; when supplied it must match the attempt/user. */
  wallet?: string;
  providerReference?: string;
  reason?: string;
}

const KYC_WEBHOOK_PROVIDER = "kyc";
const KYC_WEBHOOK_PROCESSING_LEASE_MS = 5 * 60 * 1000;
const KYC_WEBHOOK_ERROR_MAX_LENGTH = 2000;

export type KycDocumentType = "passport" | "national_id" | "drivers_license";

export interface KycDocumentSubmission {
  documentType: KycDocumentType;
  documentNumber: string;
  ipfsDocumentUrl: string;
}

export interface KycSubmissionInput {
  sellerDetails?: Record<string, unknown>;
  businessName?: string;
  companyName?: string;
  businessRegistrationNumber?: string;
  registrationNumber?: string;
  taxId?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  documentCids?: string[] | Record<string, string>;
  documentCid?: string;
  cids?: string[];
  ipfsCids?: string[];
  documents?: Record<string, unknown> | string[];
  documentType?: KycDocumentType | string;
  documentNumber?: string;
  ipfsDocumentUrl?: string;
  providerReference?: string;
  verificationType?: KYCVerificationType;
  [key: string]: unknown;
}

export interface KycStatusResponse {
  id?: string;
  status: KYCStatus;
  rejectionReason: string | null;
  wallet?: string | null;
  documents?: Record<string, unknown> | null;
  verifiedAt?: Date | null;
}

export interface KycReviewInput {
  status?: KYCStatus | string;
  action?: string;
  decision?: string;
  reason?: string;
  rejectionReason?: string;
  reviewerId?: string;
  reviewerWallet?: string;
}

/**
 * Active attempts block a new submission. Kept in one place so the service,
 * the partial unique indexes, and status selection agree on what "active" is.
 */
const ACTIVE_KYC_STATUSES = [KYCStatus.PENDING, KYCStatus.IN_REVIEW, KYCStatus.APPROVED];

/** Statuses that allow resubmission (rejected or expired). */
const RESUBMITTABLE_STATUSES = [KYCStatus.REJECTED, KYCStatus.EXPIRED];

/** Deterministic ordering for the active attempt (pending rows have no verifiedAt). */
const ATTEMPT_ORDER = { createdAt: "DESC", id: "DESC" } as const;

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const code = (error.driverError as { code?: string } | undefined)?.code;
  // 23505: Postgres unique_violation; SQLite constraint codes in local/test runs.
  return (
    code === "23505" ||
    code === "SQLITE_CONSTRAINT" ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  );
}

export class KycService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly webhookSecret: string,
    private readonly appLogger: AppLogger = logger,
    private readonly notificationService?: NotificationService
  ) {}

  /**
   * Issue #739 — serialize every state-changing KYC operation for a user.
   * The transaction-scoped advisory lock also serializes first submissions
   * (where no row exists yet to lock) and resubmissions across API replicas.
   */
  private async lockAttemptScope(manager: EntityManager, userId: string): Promise<void> {
    if (this.dataSource.options?.type !== "postgres" || typeof manager.query !== "function") {
      return;
    }
    await manager.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `kyc:attempt:${userId}`,
    ]);
  }

  /** Map the active-attempt unique-index race to the documented HTTP 409. */
  private async withAttemptConflictMapping<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, "A KYC verification is already pending or in review for this wallet.");
      }
      throw error;
    }
  }

  async submitKycVerification(
    userId: string,
    providerData: KycProviderData = {}
  ): Promise<KYCVerification> {
    return this.withAttemptConflictMapping(() =>
      this.dataSource.transaction(async (manager) => {
        const user = await manager.getRepository(User).findOneBy({ id: userId });
        if (!user) throw new HttpError(404, "User not found.");
        await this.lockAttemptScope(manager, user.id);

        const repository = manager.getRepository(KYCVerification);
        const verification = repository.create({
          userId,
          verificationType: providerData.verificationType ?? KYCVerificationType.IDENTITY,
          status: KYCStatus.PENDING,
          verifiedAt: null,
          documents:
            providerData.documents ??
            (providerData.providerReference ? { providerReference: providerData.providerReference } : null),
        });
        const saved = await repository.save(verification);
        await manager
          .getRepository(User)
          .update(userId, { kycStatus: KYCStatus.PENDING, isKycVerified: false });
        return saved;
      })
    );
  }

  async submitKycVerificationByWallet(
    wallet: string,
    payload: KycDocumentSubmission
  ): Promise<KYCVerification> {
    return this.withAttemptConflictMapping(() =>
      this.dataSource.transaction(async (manager) => {
        const user = await manager.getRepository(User).findOne({
          where: { stellarAddress: wallet },
          ...(this.dataSource.options?.type === "postgres"
            ? { lock: { mode: "pessimistic_write" as const } }
            : {}),
        });
        if (!user) throw new HttpError(404, "User not found.");
        await this.lockAttemptScope(manager, user.id);

        const repository = manager.getRepository(KYCVerification);
        const existing = await repository.findOne({
          where: {
            wallet,
            status: In(ACTIVE_KYC_STATUSES),
          },
          order: ATTEMPT_ORDER,
        });
        const submissionFingerprint = crypto
          .createHash("sha256")
          .update(stableJson(payload))
          .digest("hex");
        if (existing) {
          const existingDocs = existing.documents as Record<string, unknown> | null;
          const existingPayload = {
            documentType: existingDocs?.documentType,
            documentNumber: existingDocs?.documentNumber,
            ipfsDocumentUrl: existingDocs?.ipfsDocumentUrl,
          };
          if (
            existingDocs?.submissionFingerprint === submissionFingerprint ||
            stableJson(existingPayload) === stableJson(payload)
          ) {
            return existing;
          }
          throw new HttpError(
            409,
            "A KYC verification is already pending or approved for this wallet."
          );
        }

        const verification = repository.create({
          userId: user.id,
          wallet,
          verificationType: KYCVerificationType.IDENTITY,
          status: KYCStatus.PENDING,
          verifiedAt: null,
          documents: {
            documentType: payload.documentType,
            documentNumber: payload.documentNumber,
            ipfsDocumentUrl: payload.ipfsDocumentUrl,
            submissionFingerprint,
            rejectionReason: null,
          },
        });
        const saved = await repository.save(verification);

        await manager
          .getRepository(User)
          .update(user.id, { kycStatus: KYCStatus.PENDING, isKycVerified: false });

        this.appLogger.info("kyc.submission.created", {
          user_id: user.id,
          wallet,
          document_type: payload.documentType,
          verification_id: saved.id,
        });

        return saved;
      })
    );
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature || !this.webhookSecret) return false;
    const supplied = signature.replace(/^sha256=/, "");
    const expected = crypto.createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    const suppliedBuffer = Buffer.from(supplied, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    return (
      suppliedBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
    );
  }

  /**
   * Applies a provider callback to exactly one current attempt.
   *
   * Issue #737 — callbacks are matched to the current attempt/provider
   * reference, the status comparison and all writes happen in one locked
   * transaction, an already-applied identical result is an idempotent no-op,
   * and a conflicting/stale decision is a permanent 409.
   * Issue #738 — the resulting decision (including its reason) is persisted on
   * the current verification and in history with consistent status semantics.
   */
  async processWebhook(payload: KycWebhookPayload): Promise<void> {
    const eventId = this.getWebhookEventId(payload);
    const eventRepository = this.dataSource.getRepository?.(KycWebhookEvent);
    const eventStoreAvailable =
      !!eventRepository &&
      typeof eventRepository.createQueryBuilder === "function" &&
      typeof eventRepository.findOneBy === "function" &&
      typeof eventRepository.update === "function";

    if (eventStoreAvailable) {
      await eventRepository!
        .createQueryBuilder()
        .insert()
        .into(KycWebhookEvent)
        .values({
          provider: KYC_WEBHOOK_PROVIDER,
          eventId,
          status: "received",
          payload,
          attemptCount: 0,
          errorMessage: null,
          failureKind: null,
          receivedAt: new Date(),
          processingStartedAt: null,
          completedAt: null,
        })
        .orIgnore()
        .execute();

      const now = new Date();
      const expiredBefore = new Date(now.getTime() - KYC_WEBHOOK_PROCESSING_LEASE_MS);
      const claim = await eventRepository!
        .createQueryBuilder()
        .update(KycWebhookEvent)
        .set({
          status: "processing",
          attemptCount: () => '"attempt_count" + 1',
          errorMessage: null,
          failureKind: null,
          processingStartedAt: now,
          completedAt: null,
        })
        .where(
          "provider = :provider AND event_id = :eventId AND status <> :succeeded AND (status <> :processing OR processing_started_at <= :expiredBefore)",
          {
            provider: KYC_WEBHOOK_PROVIDER,
            eventId,
            succeeded: "succeeded",
            processing: "processing",
            expiredBefore,
          }
        )
        .execute();

      if (!claim.affected) {
        const current = await eventRepository!.findOneBy({
          provider: KYC_WEBHOOK_PROVIDER,
          eventId,
        });
        if (current?.status === "succeeded") {
          this.appLogger.info("kyc.webhook.already_processed", {
            provider: KYC_WEBHOOK_PROVIDER,
            event_id: eventId,
          });
          return;
        }
        throw new HttpError(503, "Webhook event is already being processed.");
      }
    }

    try {
      if (!payload || typeof payload.userId !== "string" || !payload.userId.trim()) {
        throw new HttpError(400, "Webhook userId is required.");
      }
      if (![KYCStatus.APPROVED, KYCStatus.REJECTED].includes(payload.status)) {
        throw new HttpError(400, "Webhook status must be approved or rejected.");
      }

      const result = await this.dataSource.transaction(async (manager) => {
        const userRepository = manager.getRepository(User);
        const verificationRepository = manager.getRepository(KYCVerification);
        const historyRepository = manager.getRepository(KycHistory);
        const user = await userRepository.findOneBy({ id: payload.userId });
        if (!user) throw new HttpError(404, "User not found.");
        await this.lockAttemptScope(manager, user.id);

        const lock =
          this.dataSource.options?.type === "postgres"
            ? { lock: { mode: "pessimistic_write" as const } }
            : {};
        const suppliedVerificationId =
          typeof payload.verificationId === "string" ? payload.verificationId.trim() : "";

        // Pin the callback to a specific attempt. Without an explicit id only
        // the current active attempt may be decided.
        const verification = await verificationRepository.findOne({
          where: suppliedVerificationId
            ? { id: suppliedVerificationId, userId: user.id }
            : { userId: user.id, status: In(ACTIVE_KYC_STATUSES) },
          order: ATTEMPT_ORDER,
          ...lock,
        });
        if (!verification || verification.userId !== user.id) {
          throw new HttpError(404, "KYC verification not found.");
        }

        // A delayed callback for an archived attempt must never approve the
        // current one, even if the archived row is still pending.
        const currentAttempt = await verificationRepository.findOne({
          where: { userId: user.id, verificationType: verification.verificationType },
          order: ATTEMPT_ORDER,
          ...lock,
        });
        if (currentAttempt && currentAttempt.id !== verification.id) {
          throw new HttpError(409, "KYC webhook verification is not the current attempt.");
        }

        const suppliedWallet =
          typeof payload.wallet === "string" ? payload.wallet.trim() : null;
        if (
          (suppliedWallet && suppliedWallet !== user.stellarAddress) ||
          (suppliedWallet && verification.wallet && suppliedWallet !== verification.wallet)
        ) {
          throw new HttpError(409, "KYC webhook wallet does not match the verification attempt.");
        }

        const existingDocs = (verification.documents ?? {}) as Record<string, unknown>;
        const storedReference =
          typeof existingDocs.providerReference === "string"
            ? existingDocs.providerReference
            : null;
        const suppliedReference =
          typeof payload.providerReference === "string" ? payload.providerReference.trim() : null;
        if (suppliedReference && storedReference && suppliedReference !== storedReference) {
          throw new HttpError(409, "KYC webhook provider reference does not match the attempt.");
        }

        const succeeded = async (): Promise<void> => {
          if (!eventStoreAvailable) return;
          const update = await manager.getRepository(KycWebhookEvent).update(
            { provider: KYC_WEBHOOK_PROVIDER, eventId, status: "processing" },
            {
              status: "succeeded",
              errorMessage: null,
              failureKind: null,
              processingStartedAt: null,
              completedAt: new Date(),
            }
          );
          if (!update.affected) {
            throw new Error("KYC webhook processing claim was lost before completion.");
          }
        };

        if (verification.status !== KYCStatus.PENDING) {
          const appliedSameDecision =
            existingDocs.decision === payload.status &&
            existingDocs.decisionSource === "webhook" &&
            (!suppliedReference ||
              !existingDocs.decisionProviderReference ||
              existingDocs.decisionProviderReference === suppliedReference);
          if (!appliedSameDecision) {
            throw new HttpError(409, "KYC verification attempt is no longer pending.");
          }
          // Identical replay: mark the event handled but do not touch the
          // verification, user, history, or notification state again.
          await succeeded();
          return { verificationId: verification.id, applied: false };
        }

        const decisionDocs: Record<string, unknown> = { ...existingDocs };
        delete decisionDocs.rejectionReason;
        delete decisionDocs.reason;
        const reason =
          typeof payload.reason === "string" && payload.reason.trim()
            ? payload.reason.trim()
            : null;
        decisionDocs.decision = payload.status;
        decisionDocs.decisionSource = "webhook";
        decisionDocs.decisionEventId = eventId;
        decisionDocs.decisionProviderReference = suppliedReference ?? storedReference ?? null;
        if (suppliedReference) decisionDocs.providerReference = suppliedReference;
        if (payload.status === KYCStatus.REJECTED) decisionDocs.rejectionReason = reason;

        verification.status = payload.status;
        verification.verifiedAt = new Date();
        verification.documents = decisionDocs;
        await verificationRepository.save(verification);

        const historyEntry = historyRepository.create({
          userId: user.id,
          wallet: verification.wallet,
          verificationType: verification.verificationType,
          // History always records the resulting decision, never the previous
          // status, so reasons are never attached to a pending row.
          status: payload.status,
          documents: decisionDocs,
          rejectionReason: payload.status === KYCStatus.REJECTED ? reason : null,
          providerReference: suppliedReference ?? storedReference ?? null,
          isArchived: true,
          archivedAt: new Date(),
        });
        await historyRepository.save(historyEntry);

        await userRepository.update(payload.userId, {
          kycStatus: payload.status,
          isKycVerified: payload.status === KYCStatus.APPROVED,
        });

        await succeeded();
        return { verificationId: verification.id, applied: true };
      });

      this.appLogger.info("kyc.webhook.processed", {
        user_id: payload.userId,
        verification_id: result.verificationId,
        status: payload.status,
        applied: result.applied,
        provider: KYC_WEBHOOK_PROVIDER,
        event_id: eventId,
      });
      if (!result.applied) return;
    } catch (error) {
      const statusCode =
        typeof error === "object" && error !== null && "statusCode" in error
          ? Number((error as { statusCode: unknown }).statusCode)
          : 500;
      const failureKind = statusCode >= 400 && statusCode < 500 ? "permanent" : "retryable";
      const errorMessage = (error instanceof Error ? error.message : String(error)).slice(
        0,
        KYC_WEBHOOK_ERROR_MAX_LENGTH
      );
      if (eventStoreAvailable) {
        await eventRepository!.update(
          { provider: KYC_WEBHOOK_PROVIDER, eventId, status: "processing" },
          { status: "failed", errorMessage, failureKind, processingStartedAt: null }
        );
      }
      this.appLogger.error("kyc.webhook.failed", {
        provider: KYC_WEBHOOK_PROVIDER,
        event_id: eventId,
        failure_kind: failureKind,
        error: errorMessage,
      });
      throw error;
    }

    try {
      const notifType =
        payload.status === KYCStatus.APPROVED
          ? NotificationType.KYC_APPROVED
          : NotificationType.KYC_REJECTED;
      const title = payload.status === KYCStatus.APPROVED ? "KYC Approved" : "KYC Status Updated";
      const message =
        payload.status === KYCStatus.APPROVED
          ? "Your identity verification has been approved."
          : `Your KYC status has changed to ${payload.status}.`;
      await this.notificationService?.createNotification(
        payload.userId,
        notifType,
        title,
        message,
        { status: payload.status, reason: payload.reason ?? null }
      );
    } catch (error) {
      this.appLogger.warn("kyc.notification.failed", {
        user_id: payload.userId,
        error,
      });
    }
  }

  private getWebhookEventId(payload: unknown): string {
    const candidate =
      typeof payload === "object" && payload !== null
        ? ((payload as Record<string, unknown>).eventId ?? (payload as Record<string, unknown>).id)
        : undefined;
    const suppliedId = typeof candidate === "string" ? candidate.trim() : "";
    const identity =
      suppliedId ||
      `sha256:${crypto
        .createHash("sha256")
        .update(JSON.stringify(payload) ?? String(payload))
        .digest("hex")}`;
    if (identity.length <= 255) return identity;
    return `sha256:${crypto.createHash("sha256").update(identity).digest("hex")}`;
  }

  /**
   * Submit a new KYC verification after rejection or expiry.
   * Previous submission is archived before creating the new one.
   * Only allowed in rejected or expired states.
   */
  async resubmitKycVerification(
    wallet: string,
    payload: KycDocumentSubmission
  ): Promise<KYCVerification> {
    return this.withAttemptConflictMapping(() =>
      this.dataSource.transaction(async (manager) => {
        const user = await manager.getRepository(User).findOne({
          where: { stellarAddress: wallet },
        });
        if (!user) throw new HttpError(404, "User not found.");
        await this.lockAttemptScope(manager, user.id);

        const verificationRepository = manager.getRepository(KYCVerification);
        const historyRepository = manager.getRepository(KycHistory);

        const currentVerification = await verificationRepository.findOne({
          where: {
            wallet,
            status: In([...ACTIVE_KYC_STATUSES, ...RESUBMITTABLE_STATUSES]),
          },
          order: ATTEMPT_ORDER,
        });

        if (!currentVerification) {
          throw new HttpError(404, "No existing KYC verification found for this wallet.");
        }

        if (!RESUBMITTABLE_STATUSES.includes(currentVerification.status)) {
          throw new HttpError(
            400,
            `Cannot resubmit KYC verification with status ${currentVerification.status}. Only rejected or expired verifications can be resubmitted.`
          );
        }

        const previousDocs = (currentVerification.documents ?? {}) as Record<string, unknown>;
        const previousReason =
          (typeof previousDocs.rejectionReason === "string" ? previousDocs.rejectionReason : null) ??
          (typeof previousDocs.reason === "string" ? previousDocs.reason : null) ??
          "Resubmitted";

        // Archive the previous decision with the same resulting status used by
        // admin review and webhook processing (#738).
        const historyEntry = historyRepository.create({
          userId: user.id,
          wallet: currentVerification.wallet,
          verificationType: currentVerification.verificationType,
          status: currentVerification.status,
          documents: currentVerification.documents,
          rejectionReason:
            currentVerification.status === KYCStatus.REJECTED ? previousReason : null,
          providerReference:
            typeof previousDocs.providerReference === "string"
              ? previousDocs.providerReference
              : null,
          isArchived: true,
          archivedAt: new Date(),
        });
        await historyRepository.save(historyEntry);

        const newVerification = verificationRepository.create({
          userId: user.id,
          wallet,
          verificationType: currentVerification.verificationType,
          status: KYCStatus.PENDING,
          verifiedAt: null,
          documents: {
            documentType: payload.documentType,
            documentNumber: payload.documentNumber,
            ipfsDocumentUrl: payload.ipfsDocumentUrl,
            rejectionReason: null,
          },
        });
        const saved = await verificationRepository.save(newVerification);

        await manager.getRepository(User).update(user.id, {
          kycStatus: KYCStatus.PENDING,
          isKycVerified: false,
        });

        this.appLogger.info("kyc.resubmission.created", {
          user_id: user.id,
          wallet,
          previous_verification_id: currentVerification.id,
          new_verification_id: saved.id,
          previous_status: currentVerification.status,
        });

        return saved;
      })
    );
  }

  /**
   * Submit KYC details and IPFS document CIDs.
   * Identical pending submissions return their existing attempt; new content
   * after rejection creates a separate review attempt.
   */
  async submitKyc(walletOrUserId: string, payload: KycSubmissionInput): Promise<KYCVerification> {
    return this.withAttemptConflictMapping(() =>
      this.dataSource.transaction(async (manager) => {
      const userRepository = manager.getRepository(User);
      const verificationRepository = manager.getRepository(KYCVerification);
      const historyRepository = manager.getRepository(KycHistory);

      const user = await userRepository.findOne({
        where: [{ stellarAddress: walletOrUserId }, { id: walletOrUserId }],
        ...(this.dataSource.options?.type === "postgres"
          ? { lock: { mode: "pessimistic_write" as const } }
          : {}),
      });
      if (!user) {
        throw new HttpError(404, "User not found.");
      }
      await this.lockAttemptScope(manager, user.id);

      const wallet = user.stellarAddress;
      const submittedAt = new Date().toISOString();

      // Extract document CIDs
      let cids: string[] = [];
      if (Array.isArray(payload.documentCids)) {
        cids = payload.documentCids.filter(
          (c): c is string => typeof c === "string" && c.trim().length > 0
        );
      } else if (payload.documentCids && typeof payload.documentCids === "object") {
        cids = Object.values(payload.documentCids).filter(
          (c): c is string => typeof c === "string" && c.trim().length > 0
        );
      } else if (Array.isArray(payload.cids)) {
        cids = payload.cids.filter(
          (c): c is string => typeof c === "string" && c.trim().length > 0
        );
      } else if (Array.isArray(payload.ipfsCids)) {
        cids = payload.ipfsCids.filter(
          (c): c is string => typeof c === "string" && c.trim().length > 0
        );
      } else if (typeof payload.documentCid === "string" && payload.documentCid.trim()) {
        cids = [payload.documentCid.trim()];
      } else if (typeof payload.ipfsDocumentUrl === "string" && payload.ipfsDocumentUrl.trim()) {
        cids = [payload.ipfsDocumentUrl.trim()];
      } else if (Array.isArray(payload.documents)) {
        cids = payload.documents.filter(
          (c): c is string => typeof c === "string" && c.trim().length > 0
        );
      }

      // Extract seller details
      const sellerDetails: Record<string, unknown> = {
        ...(payload.sellerDetails && typeof payload.sellerDetails === "object"
          ? payload.sellerDetails
          : {}),
      };
      if (payload.businessName) sellerDetails.businessName = payload.businessName;
      if (payload.companyName) sellerDetails.companyName = payload.companyName;
      if (payload.businessRegistrationNumber)
        sellerDetails.businessRegistrationNumber = payload.businessRegistrationNumber;
      if (payload.registrationNumber) sellerDetails.registrationNumber = payload.registrationNumber;
      if (payload.taxId) sellerDetails.taxId = payload.taxId;
      if (payload.contactEmail) sellerDetails.contactEmail = payload.contactEmail;
      if (payload.contactPhone) sellerDetails.contactPhone = payload.contactPhone;
      if (payload.address) sellerDetails.address = payload.address;

      const docData: Record<string, unknown> = {
        sellerDetails: Object.keys(sellerDetails).length > 0 ? sellerDetails : null,
        documentCids: cids,
        documentType: payload.documentType ?? "business",
        documentNumber: payload.documentNumber ?? null,
        ipfsDocumentUrl:
          payload.ipfsDocumentUrl ??
          (cids[0]
            ? cids[0].startsWith("ipfs://") || cids[0].startsWith("http")
              ? cids[0]
              : `ipfs://${cids[0]}`
            : null),
        providerReference: payload.providerReference ?? null,
        rejectionReason: null,
        submittedAt,
      };
      const fingerprintData = { ...docData };
      delete fingerprintData.submittedAt;
      const submissionFingerprint = crypto
        .createHash("sha256")
        .update(stableJson(fingerprintData))
        .digest("hex");
      docData.submissionFingerprint = submissionFingerprint;

      // Find existing verification
      const active = await verificationRepository.findOne({
        where: [
          { wallet, status: In(ACTIVE_KYC_STATUSES) },
          { userId: user.id, status: In(ACTIVE_KYC_STATUSES) },
        ],
        order: ATTEMPT_ORDER,
      });
      const existing =
        active ??
        (await verificationRepository.findOne({
          where: [
            { wallet, status: In(RESUBMITTABLE_STATUSES) },
            { userId: user.id, status: In(RESUBMITTABLE_STATUSES) },
          ],
          order: ATTEMPT_ORDER,
        }));

      if (existing) {
        const existingDocs = existing.documents as Record<string, unknown> | null;
        if (existingDocs?.submissionFingerprint === submissionFingerprint) return existing;
        if (existing.status === KYCStatus.PENDING) {
          throw new HttpError(409, "A KYC verification is already pending for this wallet.");
        }
        if (existing.status === KYCStatus.APPROVED) {
          throw new HttpError(409, "A KYC verification is already approved for this wallet.");
        }

        // A resubmission is a new attempt; keep the reviewed attempt immutable.
        const historyEntry = historyRepository.create({
          userId: user.id,
          wallet: existing.wallet ?? wallet,
          verificationType: existing.verificationType,
          status: existing.status,
          documents: existing.documents,
          rejectionReason:
            (typeof existingDocs?.rejectionReason === "string"
              ? existingDocs.rejectionReason
              : null) ??
            (typeof existingDocs?.reason === "string" ? existingDocs.reason : null) ??
            "Resubmitted",
          providerReference:
            typeof existingDocs?.providerReference === "string"
              ? existingDocs.providerReference
              : null,
          isArchived: true,
          archivedAt: new Date(),
        });
        await historyRepository.save(historyEntry);

        const saved = await verificationRepository.save(
          verificationRepository.create({
            userId: user.id,
            wallet,
            verificationType: payload.verificationType ?? existing.verificationType,
            status: KYCStatus.PENDING,
            documents: docData,
            verifiedAt: null,
          })
        );

        await userRepository.update(user.id, {
          kycStatus: KYCStatus.PENDING,
          isKycVerified: false,
        });

        this.appLogger.info("kyc.resubmission.created", {
          user_id: user.id,
          wallet,
          verification_id: saved.id,
          status: KYCStatus.PENDING,
        });

        return saved;
      }

      // No existing verification, create new one
      const verification = verificationRepository.create({
        userId: user.id,
        wallet,
        verificationType: payload.verificationType ?? KYCVerificationType.IDENTITY,
        status: KYCStatus.PENDING,
        documents: docData,
        verifiedAt: null,
      });

      const saved = await verificationRepository.save(verification);

      await userRepository.update(user.id, {
        kycStatus: KYCStatus.PENDING,
        isKycVerified: false,
      });

      this.appLogger.info("kyc.submission.created", {
        user_id: user.id,
        wallet,
        verification_id: saved.id,
        status: KYCStatus.PENDING,
      });

      return saved;
      })
    );
  }

  /**
   * Get current verification status for authenticated wallet/user.
   * Returns current state and rejection reason if applicable.
   */
  async getKycStatus(walletOrUserId: string): Promise<KycStatusResponse> {
    const userRepository = this.dataSource.getRepository(User);
    const verificationRepository = this.dataSource.getRepository(KYCVerification);
    const historyRepository = this.dataSource.getRepository(KycHistory);

    const user = await userRepository.findOne({
      where: [{ stellarAddress: walletOrUserId }, { id: walletOrUserId }],
    });
    if (!user) {
      throw new HttpError(404, "User not found.");
    }

    const verification = await verificationRepository.findOne({
      where: [{ wallet: user.stellarAddress }, { userId: user.id }],
      order: ATTEMPT_ORDER,
    });

    const status = verification?.status ?? user.kycStatus ?? KYCStatus.PENDING;

    let rejectionReason: string | null = null;
    if (status === KYCStatus.REJECTED) {
      const verDocs = verification?.documents as Record<string, unknown> | null;
      rejectionReason =
        (typeof verDocs?.rejectionReason === "string" ? verDocs.rejectionReason : null) ??
        (typeof verDocs?.reason === "string" ? verDocs.reason : null) ??
        null;

      if (!rejectionReason) {
        const history = await historyRepository.findOne({
          where: [
            { wallet: user.stellarAddress, status: KYCStatus.REJECTED },
            { userId: user.id, status: KYCStatus.REJECTED },
          ],
          order: { createdAt: "DESC" },
        });
        rejectionReason = history?.rejectionReason ?? null;
      }
    }

    return {
      id: verification?.id,
      status,
      rejectionReason,
      wallet: user.stellarAddress,
      documents: verification?.documents ?? null,
      verifiedAt: verification?.verifiedAt ?? null,
    };
  }

  /**
   * Admin review of a KYC verification, transitioning status to approved or rejected with reason.
   */
  async reviewKyc(idOrUserId: string, input: KycReviewInput): Promise<KYCVerification> {
    const rawAction = (input.status || input.action || input.decision || "")
      .toString()
      .toLowerCase()
      .trim();
    let decision: KYCStatus;
    if (rawAction === "approved" || rawAction === "approve") {
      decision = KYCStatus.APPROVED;
    } else if (rawAction === "rejected" || rawAction === "reject") {
      decision = KYCStatus.REJECTED;
    } else {
      throw new HttpError(400, "Status must be either 'approved' or 'rejected'.");
    }

    const reason = (input.reason || input.rejectionReason || "").toString().trim();
    if (decision === KYCStatus.REJECTED && !reason) {
      throw new HttpError(400, "Rejection reason is required when rejecting KYC verification.");
    }

    return this.dataSource.transaction(async (manager) => {
      const userRepository = manager.getRepository(User);
      const verificationRepository = manager.getRepository(KYCVerification);
      const historyRepository = manager.getRepository(KycHistory);

      // Find verification by id, userId, or wallet
      let verification = await verificationRepository.findOne({
        where: [{ id: idOrUserId }],
      });

      if (!verification) {
        verification = await verificationRepository.findOne({
          where: [{ userId: idOrUserId }, { wallet: idOrUserId }],
          order: ATTEMPT_ORDER,
        });
      }

      let user: User | null = null;
      let synthesizedAttempt = false;
      if (verification) {
        user = await userRepository.findOne({
          where: [{ id: verification.userId }, { stellarAddress: verification.wallet ?? "" }],
        });
      } else {
        user = await userRepository.findOne({
          where: [{ id: idOrUserId }, { stellarAddress: idOrUserId }],
        });
        if (user) {
          synthesizedAttempt = true;
          verification = verificationRepository.create({
            userId: user.id,
            wallet: user.stellarAddress,
            verificationType: KYCVerificationType.IDENTITY,
            status: user.kycStatus,
            verifiedAt: null,
            documents: {},
          });
        }
      }

      if (!verification || !user) {
        throw new HttpError(404, "KYC verification not found.");
      }
      await this.lockAttemptScope(manager, user.id);

      // A delayed admin review must not overwrite a newer decision (#737).
      if (
        !synthesizedAttempt &&
        verification.status !== KYCStatus.PENDING &&
        verification.status !== KYCStatus.IN_REVIEW
      ) {
        if (verification.status === decision) return verification;
        throw new HttpError(409, "KYC verification attempt has already been decided.");
      }

      const previousStatus = verification.status;
      const isApproved = decision === KYCStatus.APPROVED;

      verification.status = decision;
      verification.verifiedAt = new Date();

      const docs: Record<string, unknown> = { ...(verification.documents || {}) };
      delete docs.rejectionReason;
      delete docs.reason;
      docs.decision = decision;
      docs.decisionSource = "admin";
      if (!isApproved) docs.rejectionReason = reason;
      verification.documents = docs;

      const saved = await verificationRepository.save(verification);

      // Archive to history
      const historyEntry = historyRepository.create({
        userId: user.id,
        wallet: verification.wallet ?? user.stellarAddress,
        verificationType: verification.verificationType,
        status: decision,
        documents: docs,
        rejectionReason: isApproved ? null : reason,
        isArchived: true,
        archivedAt: new Date(),
      });
      await historyRepository.save(historyEntry);

      // Update user
      await userRepository.update(user.id, {
        kycStatus: decision,
        isKycVerified: isApproved,
      });

      // Audit log
      logKYCStatusChange(this.appLogger, {
        wallet: user.stellarAddress,
        previousStatus,
        newStatus: decision,
        reviewerWallet: input.reviewerWallet ?? input.reviewerId ?? "admin",
        reviewerId: input.reviewerId,
        action: isApproved ? "approve" : "reject",
        reason: isApproved ? undefined : reason,
      });

      // Notification
      try {
        const notifType = isApproved
          ? NotificationType.KYC_APPROVED
          : NotificationType.KYC_REJECTED;
        const notifTitle = isApproved ? "KYC Approved" : "KYC Status Updated";
        const notifMsg = isApproved
          ? "Your identity verification has been approved."
          : `Your KYC verification was rejected: ${reason}`;

        await this.notificationService?.createNotification(
          user.id,
          notifType,
          notifTitle,
          notifMsg,
          { status: decision, reason: isApproved ? null : reason }
        );
      } catch (err) {
        this.appLogger.warn("kyc.notification.failed", { user_id: user.id, error: err });
      }

      return saved;
    });
  }

  /**
   * Get all KYC submission history for a wallet.
   * Returns all records in descending order (newest first).
   */
  async getKycHistory(wallet: string): Promise<KycHistory[]> {
    const historyRepository = this.dataSource.getRepository(KycHistory);
    const history = await historyRepository.find({
      where: { wallet },
      order: { createdAt: "DESC" },
    });

    return history;
  }

  /**
   * Get KYC history for a user by user ID.
   * Returns all records in descending order (newest first).
   */
  async getKycHistoryByUserId(userId: string): Promise<KycHistory[]> {
    const historyRepository = this.dataSource.getRepository(KycHistory);
    const history = await historyRepository.find({
      where: { userId },
      order: { createdAt: "DESC" },
    });

    return history;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
