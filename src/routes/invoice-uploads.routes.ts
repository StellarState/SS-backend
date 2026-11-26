import express, { Router, type NextFunction, type Response } from "express";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";
import { InvoiceUploadService, MAX_UPLOAD_CHUNK_BYTES } from "../services/invoice-upload.service";
import type { AuthenticatedRequest } from "../types/auth";
import { ServiceError } from "../utils/service-error";
import { PublicAppError } from "../utils/http-error";

export function createInvoiceUploadsRouter(
  service: InvoiceUploadService,
  authService: AuthService
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authService);
  const handle =
    (operation: (req: AuthenticatedRequest) => Promise<unknown>, status = 200) =>
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        res.status(status).json({ success: true, data: await operation(req) });
      } catch (error) {
        next(
          error instanceof ServiceError
            ? new PublicAppError(error.statusCode, error.message, error.code, error.details)
            : error
        );
      }
    };
  const params = (req: AuthenticatedRequest) =>
    [String(req.params.id), req.user!.id, String(req.params.sessionId)] as const;
  router.post(
    "/:id/uploads",
    auth,
    handle((req) => service.start(String(req.params.id), req.user!.id, req.body ?? {}), 201)
  );
  router.get(
    "/:id/uploads/:sessionId",
    auth,
    handle((req) => service.get(...params(req)))
  );
  router.patch(
    "/:id/uploads/:sessionId",
    auth,
    express.raw({ type: "application/octet-stream", limit: MAX_UPLOAD_CHUNK_BYTES }),
    handle((req) => {
      const raw = req.headers["upload-offset"];
      const offset = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : null;
      return service.append(...params(req), offset, req.body);
    })
  );
  router.post(
    "/:id/uploads/:sessionId/complete",
    auth,
    handle((req) => service.complete(...params(req)))
  );
  router.post(
    "/:id/uploads/:sessionId/restart",
    auth,
    handle((req) => service.restart(...params(req), req.body ?? {}))
  );
  return router;
}
