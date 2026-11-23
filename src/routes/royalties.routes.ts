import type { PayoutClaimsService } from "../services/payout-claims.service";
import { RoyaltyStatementsService, StatementOptions, statementCsv } from "../services/royalty-statements.service";
import { Router, Response, NextFunction } from "express";

import { createAuthMiddleware, requireRole } from "../middleware/auth.middleware";
import { logger } from "../observability/logger";
import type { AuthService } from "../services/auth.service";
import type { RoyaltyEarningsService } from "../services/royalty-earnings.service";
import { UserType } from "../types/enums";
import { AppError } from "../utils/http-error";
import type { AuthenticatedRequest } from "../types/auth";

export interface RoyaltiesRouterDependencies {
  royaltyEarningsService: RoyaltyEarningsService;
  authService: AuthService;
  payoutClaimsService?: PayoutClaimsService;
  royaltyStatementsService?: RoyaltyStatementsService;
}

const DEFAULT_TRANSFER_LIMIT = 50;
const DEFAULT_HISTORY_LIMIT = 20;

function parseBoundedInt(
  raw: unknown,
  fallback: number,
  max: number
): number {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * Royalty endpoints for invoice creators (issue #537).
 *
 *   GET /royalties/earnings - Lifetime accruals, claims and the claimable
 *                             balance for the authenticated creator, plus the
 *                             per-transfer breakdown of every royalty event.
 *   GET /royalties/history  - Royalties the creator has claimed, newest first,
 *                             with the on-chain transaction that paid them.
 *
 * Both routes are creator-only: a seller (or `both`) account must hold a valid
 * JWT, and the figures are always scoped to that token's wallet so one creator
 * can never read another's earnings.
 */
export function createRoyaltiesRouter({
  royaltyEarningsService,
  authService,
  payoutClaimsService,
  royaltyStatementsService,
}: RoyaltiesRouterDependencies): Router {
  const router = Router();

  const requireAuth = createAuthMiddleware(authService);
  const requireCreator = requireRole([UserType.SELLER, UserType.BOTH]);

  router.get(
    "/earnings",
    requireAuth,
    requireCreator,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      try {
        const creatorWallet = req.user?.stellarAddress;
        if (!creatorWallet) {
          next(new AppError(401, "Authentication required.", "UNAUTHENTICATED"));
          return;
        }

        const transferLimit = parseBoundedInt(
          req.query.transfer_limit,
          DEFAULT_TRANSFER_LIMIT,
          200
        );
        const earnings = await royaltyEarningsService.getEarnings(creatorWallet, { transferLimit });

        res.status(200).json({ success: true, data: earnings });
      } catch (error) {
        logger.error("GET /royalties/earnings failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        next(
          error instanceof AppError
            ? error
            : new AppError(500, "Failed to retrieve royalty earnings", "ROYALTY_EARNINGS_ERROR")
        );
      }
    }
  );

  router.get(
    "/history",
    requireAuth,
    requireCreator,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      try {
        const creatorWallet = req.user?.stellarAddress;
        if (!creatorWallet) {
          next(new AppError(401, "Authentication required.", "UNAUTHENTICATED"));
          return;
        }

        const limit = parseBoundedInt(req.query.limit, DEFAULT_HISTORY_LIMIT, 100);
        const cursor = req.query.cursor ? String(req.query.cursor) : null;
        const page = await royaltyEarningsService.getClaimHistory(creatorWallet, { limit, cursor });

        res.status(200).json({
          success: true,
          data: page.items,
          meta: { hasMore: page.hasMore, nextCursor: page.nextCursor, limit },
        });
      } catch (error) {
        logger.error("GET /royalties/history failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        next(
          error instanceof AppError
            ? error
            : new AppError(500, "Failed to retrieve royalty claim history", "ROYALTY_HISTORY_ERROR")
        );
      }
    }
  );

  router.post(
    "/claims",
    requireAuth,
    requireCreator,
    async (req: AuthenticatedRequest, res, next) => {
      try {
        if (!payoutClaimsService)
          throw new AppError(503, "Claim service unavailable", "CLAIMS_UNAVAILABLE");
        const { cycleId, revision } = req.body ?? {};
        if (typeof cycleId !== "string" || typeof revision !== "number")
          throw new AppError(400, "Cycle ID and revision are required", "INVALID_CLAIM");
        const claim = await payoutClaimsService.requestRoyalty(
          req.user!.stellarAddress,
          cycleId,
          revision
        );
        res.status(claim.status === "pending" ? 202 : 200).json({ success: true, data: claim });
      } catch (error) {
        next(error);
      }
    }
  );

  function statementOptions(query: AuthenticatedRequest["query"]): StatementOptions {
    const text = (name: string): string | undefined => {
      const value = query[name];
      if (value !== undefined && typeof value !== "string")
        throw new AppError(400, "Invalid statement query", "INVALID_QUERY");
      return value as string | undefined;
    };
    return {
      limit: text("limit") === undefined ? undefined : Number(text("limit")),
      cursor: text("cursor"),
      cycleFrom: text("cycle_from"),
      cycleTo: text("cycle_to"),
      keyAddress: text("key_address"),
      revision: text("revision") === undefined ? undefined : Number(text("revision")),
    };
  }

  router.get(
    "/statements",
    requireAuth,
    requireCreator,
    async (req: AuthenticatedRequest, res, next) => {
      try {
        if (!royaltyStatementsService)
          throw new AppError(503, "Statement service unavailable", "STATEMENTS_UNAVAILABLE");
        const page = await royaltyStatementsService.list(
          req.user!.stellarAddress,
          statementOptions(req.query)
        );
        res.json({
          success: true,
          data: page.items,
          totals: page.totals,
          meta: { hasMore: page.hasMore, nextCursor: page.nextCursor },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/statements/export",
    requireAuth,
    requireCreator,
    async (req: AuthenticatedRequest, res, next) => {
      try {
        if (!royaltyStatementsService)
          throw new AppError(503, "Statement service unavailable", "STATEMENTS_UNAVAILABLE");
        const format = req.query.format ?? "json";
        if (format !== "json" && format !== "csv")
          throw new AppError(400, "Format must be json or csv", "INVALID_FORMAT");
        const statement = await royaltyStatementsService.export(
          req.user!.stellarAddress,
          statementOptions(req.query)
        );
        if (format === "csv") {
          res.setHeader("Content-Disposition", 'attachment; filename="royalty-statement.csv"');
          res.setHeader("X-Statement-Gross", statement.totals.gross);
          res.setHeader("X-Statement-Platform-Fee", statement.totals.platformFee);
          res.setHeader("X-Statement-Net", statement.totals.net);
          res.type("text/csv").send(statementCsv(statement.items));
        } else
          res.json({
            success: true,
            data: statement.items,
            totals: statement.totals,
            rowCount: statement.rowCount,
          });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/claims/:key/transaction",
    requireAuth,
    requireCreator,
    async (req: AuthenticatedRequest, res, next) => {
      try {
        if (!payoutClaimsService)
          throw new AppError(503, "Claim service unavailable", "CLAIMS_UNAVAILABLE");
        const { txHash } = req.body ?? {};
        if (typeof txHash !== "string")
          throw new AppError(400, "Transaction hash is required", "INVALID_TRANSACTION");
        const claim = await payoutClaimsService.bindTransaction(
          String(req.params.key),
          txHash,
          req.user!.stellarAddress
        );
        res.json({ success: true, data: claim });
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}
