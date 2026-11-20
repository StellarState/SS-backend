import { Router } from "express";
import { TaxStatementController } from "../controllers/tax-statement.controller";
import type { TaxStatementService } from "../services/tax-statement.service";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";
import type { AuthenticatedRequest } from "../types/auth";

export interface TaxStatementRouterDependencies {
  taxStatementService: TaxStatementService;
  authService: AuthService;
}

export function createTaxStatementRouter({
  taxStatementService,
  authService,
}: TaxStatementRouterDependencies): Router {
  const router = Router();
  const controller = new TaxStatementController(taxStatementService);
  const authMiddleware = createAuthMiddleware(authService);

  // GET /api/investors/me/statements/:year.pdf — PDF tax statement (#873)
  router.get("/me/statements/:year.pdf", authMiddleware, controller.getStatementPdf);

  // GET /api/investors/me/statements/:year.csv — CSV tax statement stream (#873)
  router.get("/me/statements/:year.csv", authMiddleware, controller.getStatementCsv);

  // GET /api/investors/me/statements/:year — JSON tax statement totals & invoice breakdown (#873)
  router.get("/me/statements/:year", authMiddleware, (req, res, next) => {
    const yearParam = String(req.params.year);
    if (yearParam.endsWith(".pdf")) {
      return controller.getStatementPdf(req as AuthenticatedRequest, res);
    }
    if (yearParam.endsWith(".csv")) {
      return controller.getStatementCsv(req as AuthenticatedRequest, res);
    }
    return controller.getStatement(req as AuthenticatedRequest, res);
  });

  return router;
}
