import { Router, type Request, type Response, type NextFunction } from "express";
import type { SecondaryDepthService } from "../services/secondary-depth.service";
import { ServiceError } from "../utils/service-error";
import { PublicAppError } from "../utils/http-error";

export function createSecondaryDepthRouter(service: SecondaryDepthService): Router {
  const router = Router();
  const handle = (history: boolean) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.invoiceId);
      const result = history
        ? await service.history(id, req.query.limit ?? 20, req.query.cursor)
        : { data: await service.current(id) };
      res.json({ success: true, ...result });
    } catch (error) {
      next(
        error instanceof ServiceError
          ? new PublicAppError(error.statusCode, error.message, error.code, error.details)
          : error
      );
    }
  };
  router.get("/invoices/:invoiceId/depth", handle(false));
  router.get("/invoices/:invoiceId/depth/history", handle(true));
  return router;
}
