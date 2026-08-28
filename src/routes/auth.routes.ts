import { Router } from "express";
import Joi from "joi";
import { createAuthController } from "../controllers/auth.controller";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import { validateBody } from "../middleware/validate.middleware";
import { createAuthRateLimitMiddleware } from "../middleware/rate-limit.middleware";
import type { AuthService } from "../services/auth.service";
import type { AppLogger } from "../observability/logger";

const challengeSchema = Joi.object({
  publicKey: Joi.string().trim().required(),
});

const verifySchema = Joi.object({
  publicKey: Joi.string().trim().required(),
  nonce: Joi.string().trim().required(),
  signature: Joi.string().trim().required(),
});

export function createAuthRouter(authService: AuthService, logger: AppLogger): Router {
  const router = Router();
  const controller = createAuthController(authService);
  const authMiddleware = createAuthMiddleware(authService);
  // `/challenge` and `/verify` are unauthenticated by design — the wallet
  // signature *is* the auth check — which makes them the obvious target for
  // brute-force/credential-stuffing-style abuse. `createAuthRateLimitMiddleware`
  // already existed for exactly this but was never wired into any router.
  const authRateLimiter = createAuthRateLimitMiddleware(logger);

  router.use((req, _res, next) => {
    req.routeBasePath = req.baseUrl;
    next();
  });

  router.post(
    "/challenge",
    authRateLimiter,
    validateBody(challengeSchema),
    controller.challenge,
  );
  router.post("/verify", authRateLimiter, validateBody(verifySchema), controller.verify);
  router.get("/me", authMiddleware, controller.me);

  return router;
}
