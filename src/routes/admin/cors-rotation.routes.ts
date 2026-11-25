import { Router, Request, Response, NextFunction } from "express";
import {
  CorsOriginRotationManager,
  CorsOriginValidationError,
  CorsRotationStateError,
  validateCorsOriginList,
} from "@/services/cors-rotation.service";
import type { AuthenticatedRequest } from "@/types/auth";
import { AppError } from "@/utils/http-error";

function resolveActor(req: Request): string {
  const authReq = req as AuthenticatedRequest;
  return authReq.user?.stellarAddress ?? authReq.user?.id ?? "admin-key";
}

export function createAdminCorsRotationRouter(
  manager: CorsOriginRotationManager,
  nodeEnv = process.env.NODE_ENV ?? "development"
): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      data: manager.getSnapshot(),
    });
  });

  router.post("/validate", (req: Request, res: Response, next: NextFunction) => {
    try {
      const origins = Array.isArray(req.body?.origins) ? (req.body.origins as string[]) : null;
      if (!origins) {
        throw new AppError(400, "'origins' must be an array of origin strings.", "INVALID_INPUT");
      }
      const normalized = validateCorsOriginList(origins, nodeEnv);
      res.status(200).json({
        success: true,
        data: { valid: true, normalizedOrigins: normalized },
      });
    } catch (err) {
      if (err instanceof CorsOriginValidationError) {
        next(new AppError(400, err.message, err.code));
        return;
      }
      next(err);
    }
  });

  router.post("/stage", (req: Request, res: Response, next: NextFunction) => {
    try {
      const origins = Array.isArray(req.body?.origins) ? (req.body.origins as string[]) : null;
      if (!origins) {
        throw new AppError(400, "'origins' must be an array of origin strings.", "INVALID_INPUT");
      }
      const snapshot = manager.stageNextOrigins(origins, resolveActor(req));
      res.status(200).json({ success: true, data: snapshot });
    } catch (err) {
      if (err instanceof CorsOriginValidationError) {
        next(new AppError(400, err.message, err.code));
        return;
      }
      next(err);
    }
  });

  router.post("/promote", (req: Request, res: Response, next: NextFunction) => {
    try {
      const snapshot = manager.promoteStagedOrigins(resolveActor(req));
      res.status(200).json({ success: true, data: snapshot });
    } catch (err) {
      if (err instanceof CorsRotationStateError) {
        next(new AppError(409, err.message, err.code));
        return;
      }
      next(err);
    }
  });

  router.post("/rollback", (req: Request, res: Response, next: NextFunction) => {
    try {
      const snapshot = manager.rollback(resolveActor(req));
      res.status(200).json({ success: true, data: snapshot });
    } catch (err) {
      if (err instanceof CorsRotationStateError) {
        next(new AppError(409, err.message, err.code));
        return;
      }
      next(err);
    }
  });

  return router;
}
