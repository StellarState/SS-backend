import { Router } from "express";
import type { DashboardService } from "../services/dashboard.service";
import { createDashboardController } from "../controllers/dashboard.controller";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";

export interface DashboardRouterDependencies {
    dashboardService: DashboardService;
    authService: AuthService;
}

export function createDashboardRouter({
    dashboardService,
    authService,
}: DashboardRouterDependencies): Router {
    const router = Router();
    const controller = createDashboardController(dashboardService);
    const authMiddleware = createAuthMiddleware(authService);

    // GET /api/v1/dashboard/seller - Get seller dashboard metrics
    router.get("/seller", authMiddleware, controller.getSellerDashboard);

    // GET /api/v1/dashboard/investor - Get investor dashboard metrics
    router.get("/investor", authMiddleware, controller.getInvestorDashboard);

    return router;
}
