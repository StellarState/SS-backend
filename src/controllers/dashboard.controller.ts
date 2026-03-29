import type { Request, Response, NextFunction } from "express";
import type { DashboardService } from "../services/dashboard.service";
import { HttpError } from "../utils/http-error";
import { ServiceError } from "../utils/service-error";
import { UserType } from "../types/enums";

export function createDashboardController(dashboardService: DashboardService) {
    return {
        async getSellerDashboard(
            req: Request,
            res: Response,
            next: NextFunction,
        ): Promise<void> {
            try {
                if (!req.user) {
                    throw new HttpError(401, "Authentication required");
                }

                // Only sellers can access seller dashboard
                if (req.user.userType !== UserType.SELLER && req.user.userType !== UserType.BOTH) {
                    throw new HttpError(403, "Only sellers can access seller dashboard");
                }

                const metrics = await dashboardService.getSellerDashboard(req.user.id);

                res.status(200).json({
                    success: true,
                    data: metrics,
                });
            } catch (error) {
                if (error instanceof ServiceError) {
                    next(new HttpError(error.statusCode, error.message));
                    return;
                }

                next(error);
            }
        },

        async getInvestorDashboard(
            req: Request,
            res: Response,
            next: NextFunction,
        ): Promise<void> {
            try {
                if (!req.user) {
                    throw new HttpError(401, "Authentication required");
                }

                // Only investors can access investor dashboard
                if (req.user.userType !== UserType.INVESTOR && req.user.userType !== UserType.BOTH) {
                    throw new HttpError(403, "Only investors can access investor dashboard");
                }

                const metrics = await dashboardService.getInvestorDashboard(req.user.id);

                res.status(200).json({
                    success: true,
                    data: metrics,
                });
            } catch (error) {
                if (error instanceof ServiceError) {
                    next(new HttpError(error.statusCode, error.message));
                    return;
                }

                next(error);
            }
        },
    };
}
