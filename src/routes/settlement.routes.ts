import { Router } from "express";
import { SettlementController } from "../controllers/settlement.controller";
import type { SettlementService } from "../services/settlement.service";
import { authenticateJWT } from "../middleware/auth.middleware";

export interface SettlementRouterDependencies {
  settlementService: SettlementService;
}

export function createSettlementRouter({
  settlementService,
}: SettlementRouterDependencies): Router {
  const router = Router();
  const controller = new SettlementController(settlementService);

  // POST /api/v1/settlements/:invoiceId - Settle a funded invoice and
  // distribute pro-rata returns to its confirmed investors
  router.post("/:invoiceId", authenticateJWT, controller.settleInvoice);
  router.get("/investors/:wallet/settlements", authenticateJWT, controller.getHistory);
  router.get("/investors/:wallet/settlements/export", authenticateJWT, controller.exportHistory);

  return router;
}
