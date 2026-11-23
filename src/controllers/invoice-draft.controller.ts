import { Response, NextFunction } from "express";
import { InvoiceDraftService, DraftData } from "../services/invoice-draft.service";
import { AppError, PublicAppError } from "../utils/http-error";
import { ServiceError } from "../utils/service-error";
import type { AuthenticatedRequest } from "../types/auth";

export class InvoiceDraftController {
  constructor(private readonly draftService: InvoiceDraftService) {}

  /**
   * PUT /invoices/drafts/:id - Upserts draft with full form field state.
   */
  async saveDraft(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const draftId = id ? (Array.isArray(id) ? id[0] : id) : null;
      const body = req.body || {};

      const sellerId = req.user?.id;
      const sellerWallet = req.user?.stellarAddress;

      if (!sellerId || !sellerWallet) {
        throw new AppError(401, "Authentication required", "UNAUTHORIZED");
      }

      let expectedRevision: number | undefined;

      const ifMatch = req.headers["if-match"];
      if (ifMatch !== undefined) {
        const raw = Array.isArray(ifMatch) ? ifMatch[0] : ifMatch;
        const cleaned = raw.replace(/^W\//, "").replace(/"/g, "").trim();
        const parsed = parseInt(cleaned, 10);
        if (!Number.isNaN(parsed)) {
          expectedRevision = parsed;
        }
      }

      if (expectedRevision === undefined) {
        if (body.revision !== undefined && body.revision !== null) {
          const parsed = Number(body.revision);
          if (!Number.isNaN(parsed)) expectedRevision = parsed;
        } else if (body.expectedRevision !== undefined && body.expectedRevision !== null) {
          const parsed = Number(body.expectedRevision);
          if (!Number.isNaN(parsed)) expectedRevision = parsed;
        }
      }

      const draftData: DraftData = {
        invoiceNumber: body.invoiceNumber,
        customerName: body.customerName,
        issuerName: body.issuerName,
        description: body.description,
        amount: body.amount,
        discountRate: body.discountRate,
        dueDate: body.dueDate,
        ipfsHash: body.ipfsHash,
        title: body.title,
        faceValue: body.faceValue,
        fundingTarget: body.fundingTarget,
        yieldBps: body.yieldBps,
        fundingDeadline: body.fundingDeadline,
        ...body,
      };

      const draft = await this.draftService.saveDraft(
        sellerId,
        sellerWallet,
        draftId,
        draftData,
        expectedRevision
      );

      res.set("ETag", `"${draft.revision}"`);
      res.status(200).json({
        success: true,
        data: {
          id: draft.id,
          revision: draft.revision,
          lastSavedAt: draft.lastSavedAt,
          expiresAt: draft.expiresAt,
        },
      });
    } catch (error) {
      if (error instanceof ServiceError) {
        let statusCode = error.statusCode;
        if (
          req.headers["if-match"] &&
          (error.code === "REVISION_CONFLICT" || error.code === "REVISION_REQUIRED")
        ) {
          statusCode = 412;
        }
        next(new PublicAppError(statusCode, error.message, error.code, error.details));
        return;
      }
      next(error);
    }
  }

  /**
   * GET /invoices/drafts - Lists all drafts for issuer with last-saved timestamp.
   */
  async listDrafts(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const sellerId = req.user?.id;

      if (!sellerId) {
        throw new AppError(401, "Authentication required", "UNAUTHORIZED");
      }

      const drafts = await this.draftService.listDrafts(sellerId);

      res.status(200).json({
        success: true,
        data: drafts,
      });
    } catch (error) {
      if (error instanceof ServiceError) {
        next(new PublicAppError(error.statusCode, error.message, error.code, error.details));
        return;
      }
      next(error);
    }
  }

  /**
   * GET /invoices/drafts/:id - Returns full draft field data for resume.
   */
  async getDraft(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const draftId = Array.isArray(id) ? id[0] : id;
      const sellerId = req.user?.id;

      if (!sellerId) {
        throw new AppError(401, "Authentication required", "UNAUTHORIZED");
      }

      const draftData = await this.draftService.getDraft(draftId, sellerId);

      if (draftData.revision !== undefined) {
        res.set("ETag", `"${draftData.revision}"`);
      }

      res.status(200).json({
        success: true,
        data: draftData,
      });
    } catch (error) {
      if (error instanceof ServiceError) {
        next(new PublicAppError(error.statusCode, error.message, error.code, error.details));
        return;
      }
      next(error);
    }
  }

  /**
   * DELETE /invoices/drafts/:id - Discards draft.
   */
  async deleteDraft(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const draftId = Array.isArray(id) ? id[0] : id;
      const sellerId = req.user?.id;

      if (!sellerId) {
        throw new AppError(401, "Authentication required", "UNAUTHORIZED");
      }

      await this.draftService.deleteDraft(draftId, sellerId);

      res.status(204).send();
    } catch (error) {
      if (error instanceof ServiceError) {
        next(new PublicAppError(error.statusCode, error.message, error.code, error.details));
        return;
      }
      next(error);
    }
  }
}

export function createInvoiceDraftController(draftService: InvoiceDraftService): InvoiceDraftController {
  return new InvoiceDraftController(draftService);
}
