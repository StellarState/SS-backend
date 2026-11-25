import { Router, type Response, type NextFunction } from "express";
import { createAuthMiddleware, requireInvestor } from "../middleware/auth.middleware";
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

  router.get(
    "/",
    auth,
    requireInvestor(),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = req.user!;
        const cursor =
          typeof req.query.cursor === "string" && req.query.cursor.trim().length > 0
            ? req.query.cursor.trim()
            : null;
        const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
        const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;

        // Legacy offset pagination parameters
        const pageRaw = req.query.page !== undefined ? Number(req.query.page) : undefined;
        const offsetRaw = req.query.offset !== undefined ? Number(req.query.offset) : undefined;
        const isOffsetPagination = !cursor && (pageRaw !== undefined || offsetRaw !== undefined);

        if (isOffsetPagination) {
          res.setHeader("Deprecation", "true");
          res.setHeader(
            "Warning",
            '299 - "Offset-based pagination is deprecated. Use cursor-based pagination instead."'
          );
        }

        // Filters and sorting
        const status = req.query.status as string | undefined;
        const invoiceStatus = req.query.invoiceStatus as string | undefined;
        const minAmount = req.query.minAmount as string | undefined;
        const maxAmount = req.query.maxAmount as string | undefined;
        const startDate = req.query.startDate as string | undefined;
        const endDate = req.query.endDate as string | undefined;
        const sortBy = (req.query.sortBy || req.query.sort) as string | undefined;
        const sortOrder = (req.query.sortOrder || req.query.order) as "ASC" | "DESC" | undefined;

        const page = await portfolioService.getPortfolio(user.id, {
          cursor,
          limit,
          page: pageRaw,
          offset: offsetRaw,
          status,
          invoiceStatus,
          minAmount,
          maxAmount,
          startDate,
          endDate,
          sortBy,
          sortOrder,
        });

        if (page.nextCursor) {
          res.setHeader("X-Next-Cursor", page.nextCursor);
        }

        res.status(200).json({ success: true, data: page });
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
