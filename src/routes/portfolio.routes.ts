import { Router, Response, NextFunction } from "express";
import type { PortfolioService } from "../services/portfolio.service";
import type { AuthService } from "../services/auth.service";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthenticatedRequest } from "../types/auth";
import { HttpError } from "../utils/http-error";
import { ServiceError } from "../utils/service-error";

export interface PortfolioRouterDependencies {
  portfolioService: PortfolioService;
  authService: AuthService;
}

export function createPortfolioRouter({
  portfolioService,
  authService,
}: PortfolioRouterDependencies): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(authService);

  // GET /api/v1/portfolio - Investor portfolio summary with active/historical positions + P&L
  router.get(
    "/",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          throw new HttpError(401, "Authentication required");
        }

        const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
        const limit = req.query.limit ? Number(req.query.limit) : undefined;

        const summary = await portfolioService.getPortfolioSummary({
          investorId: req.user.id,
          cursor,
          limit,
        });

        res.status(200).json({ success: true, data: summary });
      } catch (err) {
        if (err instanceof ServiceError) {
          next(new HttpError(err.statusCode, err.message));
          return;
        }
        next(err);
      }
    },
  );

  return router;
}
