import { Router } from "express";
import { SecondaryMarketController } from "../controllers/secondary-market.controller";
import { LISTING_SORT_KEYS, SecondaryMarketService } from "../services/secondary-market.service";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import { cursorPagination } from "../middleware/cursor-pagination.middleware";
import type { AuthService } from "../services/auth.service";

export interface SecondaryMarketRouterDependencies {
  secondaryMarketService: SecondaryMarketService;
  authService: AuthService;
}

export function createSecondaryMarketRouter({
  secondaryMarketService,
  authService,
}: SecondaryMarketRouterDependencies): Router {
  const router = Router();
  const controller = new SecondaryMarketController(secondaryMarketService);
  const authMiddleware = createAuthMiddleware(authService);

  // POST /api/v1/secondary/listings - Create a new listing
  router.post("/listings", authMiddleware, controller.createListing);

  // GET /api/v1/secondary/listings - Cursor-paginated active listings with filters (issue #559)
  router.get(
    "/listings",
    authMiddleware,
    cursorPagination({
      scope: "secondary-listings",
      sortKeys: LISTING_SORT_KEYS,
      defaultSort: "created_at",
    }),
    controller.getListings
  );

  // GET /api/v1/secondary/listings/:id - Get listing details
  router.get("/listings/:id", authMiddleware, controller.getListingById);

  // POST /api/v1/secondary/listings/:id/buy - Buy a listing
  router.post("/listings/:id/buy", authMiddleware, controller.buyListing);

  // DELETE /api/v1/secondary/listings/:id - Cancel a listing
  router.delete("/listings/:id", authMiddleware, controller.cancelListing);

  return router;
}
