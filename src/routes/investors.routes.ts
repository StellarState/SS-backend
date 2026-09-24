import { Router, Response, NextFunction } from "express";
import type { AcknowledgementService } from "../services/acknowledgement.service";
import type { AuthService } from "../services/auth.service";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthenticatedRequest } from "../types/auth";
import { HttpError } from "../utils/http-error";

export interface InvestorsRouterDependencies {
  acknowledgementService: AcknowledgementService;
  authService: AuthService;
}

export function createInvestorsRouter({
  acknowledgementService,
  authService,
}: InvestorsRouterDependencies): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(authService);

  // POST /api/v1/investors/acknowledge - record accreditation/terms acknowledgement
  router.post(
    "/acknowledge",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          throw new HttpError(401, "Authentication required");
        }

        const record = await acknowledgementService.recordAcknowledgement(req.user.id);

        res.status(201).json({
          success: true,
          data: {
            userId: record.userId,
            termsVersion: record.termsVersion,
            acknowledgedAt: record.acknowledgedAt.toISOString(),
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/v1/investors/acknowledgement-status
  router.get(
    "/acknowledgement-status",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          throw new HttpError(401, "Authentication required");
        }

        const status = await acknowledgementService.getStatus(req.user.id);

        res.status(200).json({ success: true, data: status });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
