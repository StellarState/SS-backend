import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import Joi from "joi";
import { createAuthController } from "../controllers/auth.controller";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import { validateBody } from "../middleware/validate.middleware";
import { createAuthRateLimitMiddleware } from "../middleware/rate-limit.middleware";
import type { AuthService } from "../services/auth.service";
import type { AppLogger } from "../observability/logger";

// Strict schemas: enforce Stellar G... format hint, length bounds, and sanitized inputs.
const STELLAR_PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;
const NONCE_PATTERN = /^[A-Za-z0-9:_-]+$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/=_:\-\.]+$/;

type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<void> | void;

const publicKeySchema = Joi.string()
  .trim()
  .length(56)
  .pattern(STELLAR_PUBLIC_KEY_PATTERN)
  .messages({
    "string.length": "publicKey must be 56 characters long",
    "string.pattern.base": "publicKey must be a valid Stellar public key",
  })
  .required();

const challengeSchema = Joi.object({
  publicKey: publicKeySchema,
})
  .unknown(false)
  .options({ abortEarly: false, convert: true, stripUnknown: true });

const verifySchema = Joi.object({
  publicKey: publicKeySchema,
  nonce: Joi.string()
    .trim()
    .min(16)
    .max(256)
    .pattern(NONCE_PATTERN)
    .messages({
      "string.pattern.base": "nonce contains unsupported characters",
    })
    .required(),
  signature: Joi.string()
    .trim()
    .min(16)
    .max(512)
    .pattern(SIGNATURE_PATTERN)
    .messages({
      "string.pattern.base": "signature contains unsupported characters",
    })
    .required(),
})
  .unknown(false)
  .options({ abortEarly: false, convert: true, stripUnknown: true });

function wrapAuthHandler(
  routeName: string,
  handler: AsyncRouteHandler,
  logger: AppLogger,
): RequestHandler {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      logger.error("Auth route handler failed.", {
        route: routeName,
        method: req.method,
        path: req.originalUrl || req.path,
        requestId: req.headers["x-request-id"],
        error: error instanceof Error ? error.message : "Unknown error",
      });
      next(error);
    }
  };
}

function markAuthRouteBase(): RequestHandler {
  return (req, _res, next) => {
    req.routeBasePath = req.baseUrl;
    next();
  };
}

function noStoreAuthResponse(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  };
}

export function createAuthRouter(authService: AuthService, logger: AppLogger): Router {
  const router = Router();
  const controller = createAuthController(authService);
  const authMiddleware = createAuthMiddleware(authService);
  // `/challenge` and `/verify` are unauthenticated by design: the wallet
  // signature is the auth check, so they need their own abuse protection.
  const authRateLimiter = createAuthRateLimitMiddleware(logger);

  router.use(markAuthRouteBase());
  router.use(noStoreAuthResponse());

  router.post(
    "/challenge",
    authRateLimiter,
    validateBody(challengeSchema),
    wrapAuthHandler("auth.challenge", controller.challenge as AsyncRouteHandler, logger),
  );

  router.post(
    "/verify",
    authRateLimiter,
    validateBody(verifySchema),
    wrapAuthHandler("auth.verify", controller.verify as AsyncRouteHandler, logger),
  );

  router.get(
    "/me",
    authMiddleware,
    wrapAuthHandler("auth.me", controller.me as AsyncRouteHandler, logger),
  );

  return router;
}