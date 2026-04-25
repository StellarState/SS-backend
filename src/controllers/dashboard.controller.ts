import type { Response, NextFunction } from "express";
import type { DashboardService } from "../services/dashboard.service";
import { AuthenticatedRequest } from "../types/auth";
import { HttpError } from "../utils/http-error";

export function createDashboardController(dashboardService: DashboardService) {
    return {
        async getSellerDashboard(
            req: AuthenticatedRequest,
            res: Response,
            next: NextFunction,
        ): Promise<void> {
            try {
                if (!req.user) {
                    throw new HttpError(401, "Authentication required");
                }

                const metrics = await dashboardService.getSellerDashboard(req.user.id);

                res.status(200).json({
                    success: true,
                    data: metrics,
                });
            } catch (error) {
                next(error);
            }
        },

        async getInvestorDashboard(
            req: AuthenticatedRequest,
            res: Response,
            next: NextFunction,
        ): Promise<void> {
            try {
                if (!req.user) {
                    throw new HttpError(401, "Authentication required");
                }

                const metrics = await dashboardService.getInvestorDashboard(req.user.id);

                res.status(200).json({
                    success: true,
                    data: metrics,
                });
            } catch (error) {
                next(error);
            }
        },
    };
}
