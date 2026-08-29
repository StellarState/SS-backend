import { Router, type RequestHandler } from "express";
import { SettlementController } from "../controllers/settlement.controller";
import type { SettlementService } from "../services/settlement.service";
import { authenticateJWT } from "../middleware/auth.middleware";
import { checkContractNotPaused } from "../middleware/contract-pause-guard.middleware";
import type { ContractGuardService } from "../services/stellar/contract-guard.service";

export interface SettlementRouterDependencies {
  settlementService: SettlementService;
  contractGuardService?: ContractGuardService;
  contractId?: string | null;
}

export function createSettlementRouter({
  settlementService,
  contractGuardService,
  contractId = null,
}: SettlementRouterDependencies): Router {
  const router = Router();
  const controller = new SettlementController(settlementService);

  const pauseGuard: RequestHandler[] = contractGuardService
    ? [checkContractNotPaused({ contractGuardService, contractId })]
    : [];

  // POST /api/v1/settlements/:invoiceId - Settle a funded invoice and
  // distribute pro-rata returns to its confirmed investors
  router.post("/:invoiceId", authenticateJWT, ...pauseGuard, controller.settleInvoice);

  return router;
}
