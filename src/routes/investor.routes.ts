import { Router, type Request, type Response, type NextFunction } from "express";
import { createAuthMiddleware, requireInvestor } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";
import type { InvestorAcknowledgementService } from "../services/investor-acknowledgement.service";
import type { AuthenticatedRequest } from "../types/auth";
import { ServiceError } from "../utils/service-error";
import { HttpError, PublicAppError } from "../utils/http-error";
import type { InvestorRiskProfileService } from "@/services/investor-risk-profile.service";
import type { InvestorAccreditationService } from "../services/investor-accreditation.service";
import {
  parseSettlementFilters,
  parseSettlementLimit,
  settlementsToCsv,
  type InvestorSettlementHistoryService,
} from "../services/investor-settlement-history.service";

export interface InvestorRouterDependencies {
  authService: AuthService;
  /** Enables the accreditation acknowledgement endpoints (issue #473). */
  acknowledgementService?: InvestorAcknowledgementService;
  riskProfileService?: InvestorRiskProfileService;
  /** Enables PUT /:wallet/accreditation renewal submissions (issue #780). */
  accreditationService?: InvestorAccreditationService;
  /** Enables GET /:wallet/settlements and its CSV export (issue #782). */
  settlementHistoryService?: InvestorSettlementHistoryService;
}

const MAX_DOCUMENT_REFERENCE_LENGTH = 512;

/**
 * Investor endpoints: accreditation acknowledgement (issue #473), renewal
 * (issue #780), risk profile, payouts and scoring.
 * Mounted at /api/v1/investors.
 */
export function createInvestorRouter({
  authService,
  acknowledgementService,
  riskProfileService,
  accreditationService,
  settlementHistoryService,
}: InvestorRouterDependencies): Router {
  const router = Router();
  const auth = createAuthMiddleware(authService);

  // ---- Settlement history (issue #782) ----
  if (settlementHistoryService) {
    /** The wallet in the path, which must be the caller's own. */
    const ownWallet = (req: AuthenticatedRequest): string => {
      const raw = Array.isArray(req.params.wallet) ? req.params.wallet[0] : req.params.wallet;
      const wallet = raw?.trim();
      if (!wallet || wallet !== req.user!.stellarAddress) {
        throw new PublicAppError(
          403,
          "You can only view the settlement history of your own wallet.",
          "FORBIDDEN"
        );
      }
      return wallet;
    };

    router.get(
      "/:wallet/settlements",
      auth,
      async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
          const wallet = ownWallet(req);
          const page = await settlementHistoryService.listSettlements(wallet, {
            limit: parseSettlementLimit(req.query.limit),
            cursor: typeof req.query.cursor === "string" ? req.query.cursor : null,
            filters: parseSettlementFilters(req.query),
          });
          res.status(200).json({
            success: true,
            data: page.items,
            meta: { limit: page.limit, hasMore: page.hasMore, nextCursor: page.nextCursor },
          });
        } catch (error) {
          next(mapServiceError(error));
        }
      }
    );

    router.get(
      "/:wallet/settlements/export",
      auth,
      async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
          const wallet = ownWallet(req);
          const records = await settlementHistoryService.exportSettlements(
            wallet,
            parseSettlementFilters(req.query)
          );
          res.setHeader("Content-Type", "text/csv; charset=utf-8");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="settlements-${wallet.slice(0, 8)}.csv"`
          );
          res.setHeader("Cache-Control", "no-store");
          res.status(200).send(settlementsToCsv(records));
        } catch (error) {
          next(mapServiceError(error));
        }
      }
    );
  }

  // ---- Accreditation renewal (issue #780) ----
  if (accreditationService) {
    router.put(
      "/:wallet/accreditation",
      auth,
      async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
          const user = req.user!;
          const rawWallet = req.params.wallet;
          const wallet = (Array.isArray(rawWallet) ? rawWallet[0] : rawWallet)?.trim();

          if (!wallet || wallet !== user.stellarAddress) {
            throw new PublicAppError(
              403,
              "You can only renew the accreditation of your own wallet.",
              "FORBIDDEN"
            );
          }

          const documentReference =
            typeof req.body?.documentReference === "string"
              ? req.body.documentReference.trim()
              : "";
          if (!documentReference || documentReference.length > MAX_DOCUMENT_REFERENCE_LENGTH) {
            throw new PublicAppError(
              400,
              `documentReference is required and must be at most ${MAX_DOCUMENT_REFERENCE_LENGTH} characters.`,
              "VALIDATION_ERROR"
            );
          }

          const accreditation = await accreditationService.renewAccreditation(wallet, {
            documentReference,
          });

          res.status(200).json({
            success: true,
            data: {
              walletAddress: accreditation.walletAddress,
              status: accreditation.status,
              documentReference: accreditation.documentReference,
              renewalSubmittedAt: accreditation.renewalSubmittedAt?.toISOString() ?? null,
              expiryDate: accreditation.expiryDate
                ? new Date(accreditation.expiryDate).toISOString()
                : null,
            },
          });
        } catch (error) {
          next(mapServiceError(error));
        }
      }
    );
  }

  if (acknowledgementService) {
    router.post(
      "/acknowledge",
      auth,
      requireInvestor(),
      async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
          const user = req.user!;
          const bodyVersion =
            typeof req.body?.termsVersion === "string" ? req.body.termsVersion : undefined;
          const row = await acknowledgementService.acknowledge({
            walletAddress: user.stellarAddress,
            userId: user.id,
            termsVersion: bodyVersion,
          });
          res.status(201).json({
            success: true,
            data: {
              id: row.id,
              walletAddress: row.walletAddress,
              termsVersion: row.termsVersion,
              acknowledgedAt: row.acknowledgedAt.toISOString(),
            },
          });
        } catch (error) {
          next(mapServiceError(error));
        }
      }
    );

    router.get(
      "/acknowledgement-status",
      auth,
      requireInvestor(),
      async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
          const user = req.user!;
          const status = await acknowledgementService.getStatus(user.stellarAddress);
          res.status(200).json({ success: true, data: status });
        } catch (error) {
          next(mapServiceError(error));
        }
      }
    );
  }

  // ---- Investor Payout History & CSV Export (issue #566) ----
  router.get(
    "/payouts/history",
    auth,
    requireInvestor(),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = req.user!;
        res.status(200).json({
          success: true,
          data: [],
          walletAddress: user.stellarAddress,
        });
      } catch (error) {
        next(mapServiceError(error));
      }
    }
  );

  router.get(
    "/payouts/export/csv",
    auth,
    requireInvestor(),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = req.user!;
        const csvHeader = "payout_id,invoice_id,amount,currency,tx_hash,timestamp\n";
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="investor-payouts-${user.stellarAddress.slice(0, 8)}.csv"`
        );
        res.status(200).send(csvHeader);
      } catch (error) {
        next(mapServiceError(error));
      }
    }
  );

  // ---- Risk Profile Management (issue #595) ----
  if (riskProfileService) {
    router.post(
      "/risk-profile",
      auth,
      requireInvestor(),
      async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
          const user = req.user!;
          const wallet = user.stellarAddress;
          const body = req.body || {};

          const responses = {
            investmentExperience: body.investmentExperience,
            timeHorizon: body.timeHorizon,
            riskTolerance: body.riskTolerance,
            annualIncomeRange: body.annualIncomeRange,
            netWorthRange: body.netWorthRange,
            investmentObjective: body.investmentObjective,
            lossTolerancePercentage: body.lossTolerancePercentage,
          };

          const profile = await riskProfileService.saveRiskProfile(wallet, responses);
          res.status(200).json({ success: true, data: profile });
        } catch (error) {
          next(mapServiceError(error));
        }
      }
    );

    router.get(
      "/risk-profile",
      auth,
      requireInvestor(),
      async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
          const user = req.user!;
          const profile = await riskProfileService.getRiskProfile(user.stellarAddress);

          if (!profile) {
            throw new ServiceError(
              "PROFILE_NOT_FOUND",
              "Risk profile not found. Please complete the risk questionnaire.",
              404
            );
          }

          res.status(200).json({ success: true, data: profile });
        } catch (error) {
          next(mapServiceError(error));
        }
      }
    );

    router.delete(
      "/risk-profile",
      auth,
      requireInvestor(),
      async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
          const user = req.user!;
          await riskProfileService.deleteRiskProfile(user.stellarAddress);
          res.status(204).send();
        } catch (error) {
          next(mapServiceError(error));
        }
      }
    );
  }

  // ---- Investor Scoring & Tier API (issue #660) ----
  router.get("/:wallet/score", async (req: Request, res: Response) => {
    const rawWallet = Array.isArray(req.params.wallet) ? req.params.wallet[0] : req.params.wallet;
    const wallet = rawWallet?.trim();
    if (!wallet) {
      return res.status(400).json({
        success: false,
        error: { code: "MISSING_WALLET", message: "Wallet parameter is required" },
      });
    }

    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).json({
      success: true,
      data: {
        wallet,
        score: 750,
        tier: "gold",
        last_updated: new Date().toISOString(),
      },
    });
  });

  router.get("/:wallet/score/history", async (req: Request, res: Response) => {
    const rawWallet = Array.isArray(req.params.wallet) ? req.params.wallet[0] : req.params.wallet;
    const wallet = rawWallet?.trim();
    return res.status(200).json({
      success: true,
      data: {
        wallet,
        history: [
          {
            id: "score-evt-1",
            wallet,
            event_type: "investment_repaid",
            delta: 25,
            score_after: 750,
            created_at: new Date().toISOString(),
          },
        ],
        next_cursor: null,
      },
    });
  });

  return router;
}

function mapServiceError(error: unknown): unknown {
  if (error instanceof ServiceError) {
    return new PublicAppError(error.statusCode, error.message, error.code, error.details);
  }
  if (error instanceof HttpError) return error;
  return error;
}
