import { Router, Request, Response, NextFunction, type RequestHandler } from "express";
import { SecondaryMarketController } from "../controllers/secondary-market.controller";
import { SecondaryMarketService } from "../services/secondary-market.service";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";
import type { AuthenticatedRequest } from "../types/auth";
import type { InvestorAccreditationService } from "../services/investor-accreditation.service";
import {
  invoiceIdFromSecondaryListing,
  requireUnexpiredAccreditation,
} from "../middleware/accreditation-expiry.middleware";

export interface SecondaryMarketRouterDependencies {
  secondaryMarketService: SecondaryMarketService;
  authService: AuthService;
  /** Issue #780 — blocks secondary purchases with an expired accreditation. */
  accreditationService?: InvestorAccreditationService;
}

export function createSecondaryMarketRouter({
  secondaryMarketService,
  authService,
  accreditationService,
}: SecondaryMarketRouterDependencies): Router {
  const router = Router();
  const controller = new SecondaryMarketController(secondaryMarketService);
  const authMiddleware = createAuthMiddleware(authService);

  const optionalAuth = (req: Request, res: Response, next: NextFunction) => {
    if (req.headers && req.headers.authorization) {
      return authMiddleware(req as AuthenticatedRequest, res, next);
    }
    next();
  };

  // POST /secondary-market/listings - Create a new listing
  router.post("/listings", authMiddleware, controller.createListing);

  // GET /secondary-market/listings - Get active listings with filters
  router.get("/listings", optionalAuth, controller.getListings);

  // GET /secondary-market/listings/:id - Get listing details
  router.get("/listings/:id", optionalAuth, controller.getListingById);

  const accreditationGuard: RequestHandler[] = accreditationService
    ? [
        requireUnexpiredAccreditation({
          accreditationService,
          resolveInvoiceId: invoiceIdFromSecondaryListing(accreditationService),
        }),
      ]
    : [];

  // POST /secondary/listings/:id/purchase - Buy (part of) a listing (issue #783)
  router.post(
    "/listings/:id/purchase",
    authMiddleware,
    ...accreditationGuard,
    controller.buyListing
  );

  // POST /secondary-market/listings/:id/buy - Original alias of /purchase
  router.post("/listings/:id/buy", authMiddleware, ...accreditationGuard, controller.buyListing);

  router.patch("/listings/:id", authMiddleware, controller.relistListing);

  // DELETE /secondary-market/listings/:id - Cancel a listing
  router.delete("/listings/:id", authMiddleware, controller.cancelListing);

  // POST /secondary-market/listings/:id/cancel - Cancel a listing (POST alias)
  router.post("/listings/:id/cancel", authMiddleware, controller.cancelListing);

  return router;
}
