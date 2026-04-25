import { Router } from "express";
import type { DashboardService } from "../services/dashboard.service";
import { createDashboardController } from "../controllers/dashboard.controller";
import { authenticateJWT } from "../middleware/auth.middleware";

export function createDashboardRouter(dashboardService: DashboardService): Router {
    const router = Router();
    const controller = createDashboardController(dashboardService);

    // GET /api/v1/dashboard/seller - Get seller dashboard aggregates
    router.get("/seller", authenticateJWT, controller.getSellerDashboard);

    // GET /api/v1/dashboard/investor - Get investor dashboard aggregates
    router.get("/investor", authenticateJWT, controller.getInvestorDashboard);

    return router;
}
