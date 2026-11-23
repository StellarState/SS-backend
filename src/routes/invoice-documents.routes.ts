import { Router, type NextFunction, type Response } from "express";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";
import type { InvoiceDocumentService } from "../services/invoice-document.service";
import type { AuthenticatedRequest } from "../types/auth";
import { ServiceError } from "../utils/service-error";
import { PublicAppError } from "../utils/http-error";

export interface InvoiceDocumentsRouterDependencies {
  invoiceDocumentService: InvoiceDocumentService;
  authService: AuthService;
}

function mapServiceError(error: unknown): unknown {
  if (error instanceof ServiceError) {
    return new PublicAppError(error.statusCode, error.message, error.code, error.details);
  }
  return error;
}

function invoiceIdParam(req: AuthenticatedRequest): string {
  const raw = req.params.id;
  return String(Array.isArray(raw) ? raw[0] : (raw ?? "")).trim();
}

/**
 * Invoice document registration and retrieval (issue #781).
 * Mounted at /api/v1/invoices.
 *
 * POST /:id/documents — invoice owner registers an IPFS CID
 *   body: { cid, document_type, file_size_bytes, filename?, mime_type? }
 * GET  /:id/documents — active (non-withdrawn) documents for the viewer
 */
export function createInvoiceDocumentsRouter({
  invoiceDocumentService,
  authService,
}: InvoiceDocumentsRouterDependencies): Router {
  const router = Router();
  const auth = createAuthMiddleware(authService);

  router.post(
    "/:id/documents",
    auth,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = req.user!;
        const body = (req.body ?? {}) as Record<string, unknown>;
        const document = await invoiceDocumentService.registerDocument({
          invoiceId: invoiceIdParam(req),
          requester: { id: user.id, userType: user.userType, role: user.role },
          cid: body.cid,
          documentType: body.document_type,
          fileSizeBytes: body.file_size_bytes,
          filename: body.filename,
          mimeType: body.mime_type,
          contentChecksum: body.content_checksum,
          uploadSessionId: body.upload_session_id,
        });
        res.status(201).json({ success: true, data: document });
      } catch (error) {
        next(mapServiceError(error));
      }
    }
  );

  router.get(
    "/:id/documents",
    auth,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = req.user!;
        const documents = await invoiceDocumentService.listDocuments(invoiceIdParam(req), {
          id: user.id,
          userType: user.userType,
          role: user.role,
        });
        res.status(200).json({ success: true, data: documents });
      } catch (error) {
        next(mapServiceError(error));
      }
    }
  );

  return router;
}
