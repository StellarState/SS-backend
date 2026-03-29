import { Router } from "express";
import type { SettlementService } from "../services/settlement.service";
import { createSettlementController } from "../controllers/settlement.controller";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";

export interface SettlementRouterDependencies {
    settlementService: SettlementService;
    authService: AuthService;
}

export function createSettlementRouter({
    settlementService,
    authService,
}: SettlementRouterDependencies): Router {
    const router = Router();
    const controller = createSettlementController(settlementService);
    const authMiddleware = createAuthMiddleware(authService);

    // POST /api/v1/settlement/:id - Settle an invoice
    router.post("/:id", authMiddleware, controller.settleInvoice);

    return router;
}
