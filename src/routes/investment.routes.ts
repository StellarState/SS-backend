import { Router } from "express";
import { InvestmentController } from "../controllers/investment.controller";
import { InvestmentService } from "../services/investment.service";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import { createWalletRateLimiter } from "../middleware/rate-limit-wallet.middleware";
import { requireAcknowledgement } from "../middleware/require-acknowledgement.middleware";
import type { AuthService } from "../services/auth.service";
import type { AcknowledgementService } from "../services/acknowledgement.service";

export interface InvestmentRouterDependencies {
  investmentService: InvestmentService;
  authService: AuthService;
  /** When provided, gates POST / behind investor accreditation acknowledgement (#473). */
  acknowledgementService?: AcknowledgementService;
}

// Per-wallet rate limit: max 10 investment submissions per 60 seconds
const investmentRateLimiter = createWalletRateLimiter(
  { windowMs: 60_000, maxRequests: 10 },
  "investment-create",
);

export function createInvestmentRouter({
  investmentService,
  authService,
  acknowledgementService,
}: InvestmentRouterDependencies): Router {
  const router = Router();
  const controller = new InvestmentController(investmentService);
  const authMiddleware = createAuthMiddleware(authService);

  const acknowledgementGate = acknowledgementService
    ? [requireAcknowledgement(acknowledgementService)]
    : [];

  // POST /api/v1/investments - Create a new investment commitment
  router.post(
    "/",
    authMiddleware,
    ...acknowledgementGate,
    investmentRateLimiter,
    controller.createInvestment,
  );

  // GET /api/v1/investments/dashboard - Investor portfolio aggregate
  router.get("/dashboard", authMiddleware, controller.getDashboard);

  return router;
}
