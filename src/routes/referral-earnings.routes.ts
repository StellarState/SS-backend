import { Router, Request, Response, NextFunction } from "express";

import { logger } from "../observability/logger";
import type { ReferralEarningsService } from "../services/referral-earnings.service";
import { AppError } from "../utils/http-error";

export interface ReferralEarningsRouterDependencies {
  referralEarningsService: ReferralEarningsService;
}

const DEFAULT_EARNINGS_LIMIT = 20;
const MAX_EARNINGS_LIMIT = 100;

function parseBoundedInt(raw: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseOptionalDate(raw: unknown, paramName: string): Date | null {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return null;
  }
  const value = String(raw).trim();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, `Invalid date for query parameter '${paramName}'.`, "INVALID_DATE");
  }
  return parsed;
}

/**
 * Referral earnings endpoints for investor wallets.
 *
 *   GET /api/v1/referrals/:wallet/stats    - Referred wallet count, total earned,
 *                                            and live on-chain unclaimed balance.
 *   GET /api/v1/referrals/:wallet/earnings - Cursor-paginated referral earnings
 *                                            history with optional date range filter.
 */
export function createReferralEarningsRouter({
  referralEarningsService,
}: ReferralEarningsRouterDependencies): Router {
  const router = Router();

  router.get(
    "/:wallet/stats",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const wallet = String(req.params.wallet ?? "").trim();
        if (!wallet) {
          next(new AppError(400, "Wallet address is required.", "INVALID_WALLET"));
          return;
        }

        const stats = await referralEarningsService.getStats(wallet);
        res.status(200).json({ success: true, data: stats });
      } catch (error) {
        logger.error("GET /referrals/:wallet/stats failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        next(
          error instanceof AppError
            ? error
            : new AppError(500, "Failed to retrieve referral stats", "REFERRAL_STATS_ERROR")
        );
      }
    }
  );

  router.get(
    "/:wallet/earnings",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const wallet = String(req.params.wallet ?? "").trim();
        if (!wallet) {
          next(new AppError(400, "Wallet address is required.", "INVALID_WALLET"));
          return;
        }

        const limit = parseBoundedInt(
          req.query.limit,
          DEFAULT_EARNINGS_LIMIT,
          MAX_EARNINGS_LIMIT
        );
        const cursor = req.query.cursor ? String(req.query.cursor) : null;

        const rawFrom = req.query.from ?? req.query.start_date ?? req.query.startDate;
        const rawTo = req.query.to ?? req.query.end_date ?? req.query.endDate;

        const from = parseOptionalDate(rawFrom, "from");
        const to = parseOptionalDate(rawTo, "to");

        const page = await referralEarningsService.getEarnings(wallet, {
          limit,
          cursor,
          from,
          to,
        });

        res.status(200).json({
          success: true,
          data: page.items,
          meta: {
            hasMore: page.hasMore,
            nextCursor: page.nextCursor,
            limit,
          },
        });
      } catch (error) {
        logger.error("GET /referrals/:wallet/earnings failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        next(
          error instanceof AppError
            ? error
            : new AppError(500, "Failed to retrieve referral earnings", "REFERRAL_EARNINGS_ERROR")
        );
      }
    }
  );

  return router;
}
