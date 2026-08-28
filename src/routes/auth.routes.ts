import { Router } from "express";
import Joi from "joi";
import { createAuthController } from "../controllers/auth.controller";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import { validateBody } from "../middleware/validate.middleware";
import { createRateLimitMiddleware } from "../middleware/rate-limit.middleware";
import { logger } from "../observability/logger";
import type { AuthService } from "../services/auth.service";

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

export function createAuthRouter(authService: AuthService): Router {
  const router = Router();
  const controller = createAuthController(authService);
  const authMiddleware = createAuthMiddleware(authService);

  // Isolated rate limiters for auth endpoints to prevent brute-force & enumeration
  const challengeLimiter = createRateLimitMiddleware(logger, {
    windowMs: 60 * 1000,
    max: 20,
    message: "Too many challenge requests, please try again later.",
    code: "CHALLENGE_RATE_LIMIT_EXCEEDED",
  });

  const verifyLimiter = createRateLimitMiddleware(logger, {
    windowMs: 60 * 1000,
    max: 10,
    message: "Too many verification attempts, please try again later.",
    code: "VERIFY_RATE_LIMIT_EXCEEDED",
  });

  router.use((req, _res, next) => {
    req.routeBasePath = req.baseUrl;
    next();
  });

  router.post("/challenge", challengeLimiter, validateBody(challengeSchema), controller.challenge);
  router.post("/verify", verifyLimiter, validateBody(verifySchema), controller.verify);
  router.get("/me", authMiddleware, controller.me);

  return router;
}
