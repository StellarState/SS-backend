import { DataSource, OptimisticLockVersionMismatchError } from "typeorm";
import { InvoiceDraft } from "../models/InvoiceDraft.model";
import { ServiceError } from "../utils/service-error";
import { logger } from "../observability/logger";
import { randomUUID } from "crypto";

const DRAFT_EXPIRY_DAYS = 30;

export interface DraftData {
  invoiceNumber?: string;
  customerName?: string;
  issuerName?: string;
  description?: string;
  amount?: string;
  discountRate?: string;
  dueDate?: string;
  ipfsHash?: string;
  title?: string;
  faceValue?: string;
  fundingTarget?: string;
  yieldBps?: number;
  fundingDeadline?: string;
  revision?: number;
  expectedRevision?: number;
  [key: string]: unknown;
}

export interface DraftListItem {
  id: string;
  revision: number;
  lastSavedAt: Date;
  expiresAt: Date;
}

export interface DraftResumeData extends DraftData {
  id: string;
  revision: number;
  lastSavedAt: Date;
  expiresAt: Date;
}

export class InvoiceDraftService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Generates a new draft ID.
   */
  private generateDraftId(): string {
    return `draft_${randomUUID()}`;
  }

  /**
   * Calculates expiry date for a draft.
   */
  private calculateExpiryDate(): Date {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + DRAFT_EXPIRY_DAYS);
    return expiry;
  }

  /**
   * Upserts a draft with full form field state.
   * If updating an existing draft, requires a revision precondition and performs atomic update.
   */
  async saveDraft(
    sellerId: string,
    sellerWallet: string,
    draftId: string | null,
    draftData: DraftData,
    expectedRevision?: number | null
  ): Promise<InvoiceDraft> {
    const repository = this.dataSource.getRepository(InvoiceDraft);

    // Clean up expired drafts for this seller
    await this.cleanupExpiredDrafts(sellerId);

    const id = draftId || this.generateDraftId();
    const expiresAt = this.calculateExpiryDate();

    // Check if draft exists
    const existingDraft = await repository.findOne({ where: { id } });

    const rawExpectedRevision =
      expectedRevision !== undefined && expectedRevision !== null
        ? expectedRevision
        : draftData.expectedRevision !== undefined && draftData.expectedRevision !== null
        ? draftData.expectedRevision
        : draftData.revision !== undefined && draftData.revision !== null
        ? draftData.revision
        : undefined;

    const parsedExpectedRevision =
      rawExpectedRevision !== undefined && rawExpectedRevision !== null
        ? Number(rawExpectedRevision)
        : undefined;

    const { revision: _r, expectedRevision: _er, ...cleanedDraftData } = draftData;

    if (existingDraft) {
      // Verify ownership first
      if (existingDraft.sellerId !== sellerId) {
        throw new ServiceError("FORBIDDEN", "Cannot modify another seller's draft", 403);
      }

      if (parsedExpectedRevision === undefined || Number.isNaN(parsedExpectedRevision)) {
        throw new ServiceError(
          "REVISION_REQUIRED",
          "Revision precondition is required when updating an existing draft",
          400,
          {
            currentRevision: existingDraft.revision,
            revision: existingDraft.revision,
            lastSavedAt: existingDraft.lastSavedAt,
          }
        );
      }

      if (existingDraft.revision !== parsedExpectedRevision) {
        throw new ServiceError(
          "REVISION_CONFLICT",
          `Draft revision conflict: expected revision ${parsedExpectedRevision}, but current revision is ${existingDraft.revision}`,
          409,
          {
            currentRevision: existingDraft.revision,
            revision: existingDraft.revision,
            lastSavedAt: existingDraft.lastSavedAt,
            draftData: existingDraft.draftData,
          }
        );
      }

      // Update existing draft atomically
      existingDraft.draftData = cleanedDraftData;
      existingDraft.lastSavedAt = new Date();
      existingDraft.expiresAt = expiresAt;

      try {
        const saved = await repository.save(existingDraft);

        logger.info("invoice_draft.updated", {
          draftId: id,
          sellerId,
          sellerWallet,
          revision: saved.revision,
        });

        return saved;
      } catch (err: unknown) {
        const errorObj = err as { name?: string; code?: string; message?: string } | undefined;
        if (
          err instanceof OptimisticLockVersionMismatchError ||
          errorObj?.name === "OptimisticLockVersionMismatchError"
        ) {
          const current = await repository.findOne({ where: { id } });
          throw new ServiceError(
            "REVISION_CONFLICT",
            `Draft revision conflict: expected revision ${parsedExpectedRevision}, but current revision is ${current?.revision}`,
            409,
            {
              currentRevision: current?.revision,
              revision: current?.revision,
              lastSavedAt: current?.lastSavedAt,
              draftData: current?.draftData,
            }
          );
        }
        throw err;
      }
    } else {
      // Create new draft with revision 1
      const draft = repository.create({
        id,
        sellerId,
        sellerWallet,
        draftData: cleanedDraftData,
        revision: 1,
        lastSavedAt: new Date(),
        expiresAt,
      });

      try {
        const saved = await repository.save(draft);

        logger.info("invoice_draft.created", {
          draftId: id,
          sellerId,
          sellerWallet,
          revision: saved.revision,
        });

        return saved;
      } catch (err: unknown) {
        const errorObj = err as { code?: string; message?: string } | undefined;
        if (
          errorObj?.code === "23505" ||
          String(errorObj?.message).includes("UNIQUE") ||
          String(errorObj?.message).includes("duplicate key")
        ) {
          const current = await repository.findOne({ where: { id } });
          if (current) {
            if (current.sellerId !== sellerId) {
              throw new ServiceError("FORBIDDEN", "Cannot modify another seller's draft", 403);
            }
            throw new ServiceError(
              "REVISION_CONFLICT",
              `Draft revision conflict: expected revision ${parsedExpectedRevision ?? 1}, but current revision is ${current.revision}`,
              409,
              {
                currentRevision: current.revision,
                revision: current.revision,
                lastSavedAt: current.lastSavedAt,
                draftData: current.draftData,
              }
            );
          }
        }
        throw err;
      }
    }
  }

  /**
   * Lists all resumable drafts for a seller.
   */
  async listDrafts(sellerId: string): Promise<DraftListItem[]> {
    const repository = this.dataSource.getRepository(InvoiceDraft);

    // Clean up expired drafts first
    await this.cleanupExpiredDrafts(sellerId);

    const drafts = await repository.find({
      where: { sellerId },
      order: { lastSavedAt: "DESC" },
    });

    return drafts.map((draft) => ({
      id: draft.id,
      revision: draft.revision,
      lastSavedAt: draft.lastSavedAt,
      expiresAt: draft.expiresAt,
    }));
  }

  /**
   * Returns full draft field data for resume with revision and timestamps.
   */
  async getDraft(draftId: string, sellerId: string): Promise<DraftResumeData> {
    const repository = this.dataSource.getRepository(InvoiceDraft);

    const draft = await repository.findOne({ where: { id: draftId } });

    if (!draft) {
      throw new ServiceError("DRAFT_NOT_FOUND", "Draft not found", 404);
    }

    // Verify ownership
    if (draft.sellerId !== sellerId) {
      throw new ServiceError("FORBIDDEN", "Cannot access another seller's draft", 403);
    }

    // Check if expired
    if (new Date() > draft.expiresAt) {
      await repository.remove(draft);
      throw new ServiceError("DRAFT_EXPIRED", "Draft has expired", 410);
    }

    return {
      ...(draft.draftData as DraftData),
      id: draft.id,
      revision: draft.revision,
      lastSavedAt: draft.lastSavedAt,
      expiresAt: draft.expiresAt,
    };
  }

  /**
   * Discards a draft.
   */
  async deleteDraft(draftId: string, sellerId: string): Promise<void> {
    const repository = this.dataSource.getRepository(InvoiceDraft);

    const draft = await repository.findOne({ where: { id: draftId } });

    if (!draft) {
      throw new ServiceError("DRAFT_NOT_FOUND", "Draft not found", 404);
    }

    // Verify ownership
    if (draft.sellerId !== sellerId) {
      throw new ServiceError("FORBIDDEN", "Cannot delete another seller's draft", 403);
    }

    await repository.remove(draft);

    logger.info("invoice_draft.deleted", {
      draftId,
      sellerId,
    });
  }

  /**
   * Cleans up expired drafts for a seller.
   */
  private async cleanupExpiredDrafts(sellerId: string): Promise<void> {
    const repository = this.dataSource.getRepository(InvoiceDraft);

    const now = new Date();
    const expiredDrafts = await repository
      .createQueryBuilder("draft")
      .where("draft.sellerId = :sellerId", { sellerId })
      .andWhere("draft.expiresAt < :now", { now })
      .getMany();

    if (expiredDrafts.length > 0) {
      await repository.remove(expiredDrafts);
      logger.info("invoice_draft.cleanup", {
        sellerId,
        count: expiredDrafts.length,
      });
    }
  }

  /**
   * Cleans up all expired drafts (scheduled job).
   */
  async cleanupAllExpiredDrafts(): Promise<number> {
    const repository = this.dataSource.getRepository(InvoiceDraft);

    const now = new Date();
    const expiredDrafts = await repository
      .createQueryBuilder("draft")
      .where("draft.expiresAt < :now", { now })
      .getMany();

    if (expiredDrafts.length > 0) {
      await repository.remove(expiredDrafts);
      logger.info("invoice_draft.bulk_cleanup", {
        count: expiredDrafts.length,
      });
    }

    return expiredDrafts.length;
  }
}

export function createInvoiceDraftService(dataSource: DataSource): InvoiceDraftService {
  return new InvoiceDraftService(dataSource);
}
