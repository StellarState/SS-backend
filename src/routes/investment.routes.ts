import { Router } from "express";
import { InvestmentController } from "../controllers/investment.controller";
import { InvestmentService } from "../services/investment.service";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";

export interface InvestmentRouterDependencies {
  investmentService: InvestmentService;
  authService: AuthService;
}

export function createInvestmentRouter({
  investmentService,
  authService,
}: InvestmentRouterDependencies): Router {
  const router = Router();
  const controller = new InvestmentController(investmentService);
  const authMiddleware = createAuthMiddleware(authService);

  // POST /api/v1/investments - Create a new investment commitment
  router.post("/", authMiddleware, controller.createInvestment);

  return router;
}
