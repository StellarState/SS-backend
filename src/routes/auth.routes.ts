import { Router } from "express";
import Joi from "joi";
import { createAuthController } from "../controllers/auth.controller";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import { validateBody } from "../middleware/validate.middleware";
import { createAuthRateLimitMiddleware } from "../middleware/rate-limit.middleware";
import type { AuthService } from "../services/auth.service";
import type { AppLogger } from "../observability/logger";

// Strict schemas: enforce Stellar G... format hint, length bounds, and sanitized inputs
const STELLAR_PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;

const challengeSchema = Joi.object({
  publicKey: Joi.string()
    .trim()
    .pattern(STELLAR_PUBLIC_KEY_PATTERN)
    .message("publicKey must be a valid Stellar public key")
    .required()
    .max(56),
});

const verifySchema = Joi.object({
  publicKey: Joi.string()
    .trim()
    .pattern(STELLAR_PUBLIC_KEY_PATTERN)
    .message("publicKey must be a valid Stellar public key")
    .required()
    .max(56),
  nonce: Joi.string().trim().required().min(16).max(256),
  signature: Joi.string().trim().required().min(16).max(512),
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
