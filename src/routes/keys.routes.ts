import { Router } from "express";

import { createCreatorKeyController } from "../controllers/creator-key.controller";
import { createCurveMigrationController } from "../controllers/curve-migration.controller";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";
import type { CreatorKeyService } from "../services/creator-key.service";
import type { CurveMigrationService } from "../services/curve-migration.service";

export interface KeysRouterDependencies {
  creatorKeyService: CreatorKeyService;
  curveMigrationService?: CurveMigrationService;
  authService?: AuthService;
}

export function createKeysRouter({
  creatorKeyService,
  curveMigrationService,
  authService,
}: KeysRouterDependencies): Router {
  const router = Router();
  const controller = createCreatorKeyController(creatorKeyService);

  // Public pre-trade checks: the returned caps are already enforced on-chain,
  // so no bearer token is required to read them.
  router.get("/:id/buy-limit", controller.getBuyLimit);
  router.get("/:id", controller.getKeyDetail);

  if (curveMigrationService) {
    const migrationController = createCurveMigrationController(
      creatorKeyService,
      curveMigrationService
    );
    // Pending migrations are only visible to the key's creator.
    const authMiddleware = authService ? createAuthMiddleware(authService) : undefined;

    router.get(
      "/:id/curve-migrations",
      ...(authMiddleware ? [authMiddleware] : []),
      migrationController.getCurveMigrations
    );
  }

  return router;
}
