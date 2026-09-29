import { Router, type Response, type NextFunction } from "express";
import { createAuthMiddleware, requireInvestor } from "../middleware/auth.middleware";
import { cursorPagination, paginationMeta } from "../middleware/cursor-pagination.middleware";
import type { AuthService } from "../services/auth.service";
import type { PortfolioService } from "../services/portfolio.service";
import type { AuthenticatedRequest } from "../types/auth";
import { ServiceError } from "../utils/service-error";
import { HttpError, PublicAppError } from "../utils/http-error";

export interface PortfolioRouterDependencies {
  authService: AuthService;
  portfolioService: PortfolioService;
}

/**
 * GET /portfolio — investor portfolio summary with P&L (issue #479).
 */
export function createPortfolioRouter({
  authService,
  portfolioService,
}: PortfolioRouterDependencies): Router {
  const router = Router();
  const auth = createAuthMiddleware(authService);

  // Cursor, page size and sort come from the cursorPagination middleware (issue #559).
  router.get(
    "/",
    auth,
    requireInvestor(),
    cursorPagination({ scope: "portfolio" }),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const pagination = req.pagination!;
        const page = await portfolioService.getPortfolio(req.user!.id, pagination);
        res.status(200).json({
          success: true,
          data: page,
          pagination: paginationMeta(page, pagination),
        });
      } catch (error) {
        if (error instanceof ServiceError) {
          next(new PublicAppError(error.statusCode, error.message, error.code, error.details));
          return;
        }
        next(error);
      }
    }
  );

  // GET /portfolio/payouts — settlement payout history, newest first (issue #559).
  router.get(
    "/payouts",
    auth,
    requireInvestor(),
    cursorPagination({ scope: "payouts" }),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const pagination = req.pagination!;
        const page = await portfolioService.getPayoutHistory(req.user!.id, pagination);
        res.status(200).json({
          success: true,
          data: page.payouts,
          pagination: paginationMeta(page, pagination),
        });
      } catch (error) {
        if (error instanceof ServiceError) {
          next(new PublicAppError(error.statusCode, error.message, error.code, error.details));
          return;
        }
        if (error instanceof HttpError) {
          next(error);
          return;
        }
        next(error);
      }
    }
  );

  return router;
}
