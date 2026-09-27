import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import Joi from "joi";
import { createAuthController } from "../controllers/auth.controller";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import { validateBody, validateQuery } from "../middleware/validate.middleware";
import { createAuthRateLimiter } from "../middleware/redis-rate-limit.middleware";
import { createCircuitBreaker } from "../lib/circuit-breaker";
import type { AuthService } from "../services/auth.service";
import type { AppLogger } from "../observability/logger";
import { AppError, HttpError } from "../utils/http-error";

// Strict schemas: enforce Stellar G... format hint, length bounds, and sanitized inputs.
const _STELLAR_PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;
const _NONCE_PATTERN = /^[A-Za-z0-9:_-]+$/;
const _SIGNATURE_PATTERN = /^[A-Za-z0-9+/=:_\-.]+$/;

type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<void> | void;

/** Stellar public key: `G` followed by 55 base32 chars (no padding). */
const publicKeySchema = Joi.string().trim().pattern(_STELLAR_PUBLIC_KEY_PATTERN).messages({
  "string.pattern.base": "Invalid Stellar public key format.",
});

/** Optional nonce/challenge for GET /challenge. */
const challengeQuerySchema = Joi.object({
  publicKey: publicKeySchema,
  wallet: publicKeySchema,
}).or("publicKey", "wallet");

/** Same fields for POST /challenge body. */
const challengeBodySchema = Joi.object({
  publicKey: publicKeySchema,
  wallet: publicKeySchema,
}).or("publicKey", "wallet");

const verifySchema = Joi.object({
  publicKey: publicKeySchema,
  wallet: publicKeySchema,
  nonce: Joi.string().trim().pattern(_NONCE_PATTERN).min(16).messages({
    "string.pattern.base": "Invalid nonce format.",
    "string.min": "Nonce must be at least 16 characters.",
  }),
  challenge: Joi.string().trim().pattern(_NONCE_PATTERN).min(16).messages({
    "string.pattern.base": "Invalid challenge format.",
    "string.min": "Challenge must be at least 16 characters.",
  }),
  signature: Joi.string().trim().pattern(_SIGNATURE_PATTERN).required().messages({
    "string.pattern.base": "Invalid signature format.",
    "any.required": "Signature is required.",
  }),
}).or("publicKey", "wallet").or("nonce", "challenge");

function wrapAuthHandler(
  routeName: string,
  handler: AsyncRouteHandler,
  logger: AppLogger
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
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  };
}

/* ------------------------------------------------------------------ */
/*  Idempotency middleware                                            */
/* ------------------------------------------------------------------ */

interface IdempotencyEntry {
  status: number;
  body: Record<string, unknown>;
  expiresAt: number;
}

const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000; // 1 hour
const IDEMPOTENCY_MAX_ENTRIES = 10_000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

function extractIdempotencyKey(req: Request): string | null {
  const key = req.headers["idempotency-key"] as string | undefined;
  return key && key.trim() ? key.trim() : null;
}

function createIdempotencyMiddleware(logger: AppLogger) {
  const cache = new Map<string, IdempotencyEntry>();
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  const startCleanup = () => {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
      const now = Date.now();
      let deleted = 0;
      for (const [key, value] of cache.entries()) {
        if (value.expiresAt < now) {
          cache.delete(key);
          deleted++;
        }
      }
      if (deleted > 0) {
        logger.debug("Idempotency cache cleanup", { deleted, remaining: cache.size });
      }
    }, CLEANUP_INTERVAL_MS);
    if (cleanupTimer.unref) cleanupTimer.unref();
  };

  startCleanup();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = extractIdempotencyKey(req);
    if (!key) {
      return next();
    }

    if (cache.size >= IDEMPOTENCY_MAX_ENTRIES) {
      logger.warn("Idempotency cache at capacity", { size: cache.size, max: IDEMPOTENCY_MAX_ENTRIES });
    }

    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      res.setHeader("X-Idempotency-Replay", "true");
      res.status(cached.status).json(cached.body);
      return;
    }

    // Remove stale entry if present so the Map size stays bounded.
    cache.delete(key);

    const originalJson = res.json.bind(res);
    const originalEnd = res.end.bind(res);

    let responded = false;

    const respondOnce = (body: unknown) => {
      if (responded) return;
      responded = true;

      if (res.statusCode < 400) {
        // Limit body size so we don't store huge payloads.
        const bodyObj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
        cache.set(key, { status: res.statusCode, body: bodyObj, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
      }
    };

    // Intercept both json() and end() to capture the response body.
    res.json = ((body: unknown) => {
      respondOnce(body);
      return originalJson(body);
    }) as typeof res.json;

    res.end = ((...args: unknown[]) => {
      respondOnce(null);
      return originalEnd(...(args as Parameters<typeof res.end>));
    }) as typeof res.end;

    next();
  };
}

export function createAuthRouter(authService: AuthService, logger: AppLogger): Router {
  const router = Router();
  const controller = createAuthController(authService);
  const authMiddleware = createAuthMiddleware(authService);

  const challengeRateLimiter = createAuthRateLimiter("challenge", { logger });
  const verifyRateLimiter = createAuthRateLimiter("verify", { logger });
  const idempotencyMiddleware = createIdempotencyMiddleware(logger);
  const circuitBreaker = createCircuitBreaker({ failureThreshold: 5, timeout: 30000 });

  /** Wraps a handler so failures trip the circuit breaker. */
  const withCircuitBreaker = (handler: RequestHandler): RequestHandler => {
    return async (req, res, next) => {
      try {
        await circuitBreaker.execute(async () => {
          await new Promise<void>((resolve, reject) => {
            handler(req, res, (err) => (err ? reject(err) : resolve()));
          });
        });
      } catch (error) {
        if (error instanceof Error && error.message === "Circuit breaker is open") {
          logger.warn("Circuit breaker open for auth route", {
            route: req.path,
            method: req.method,
            state: circuitBreaker.getState().state,
          });
          return next(
            new HttpError(503, "Service temporarily unavailable", "CIRCUIT_BREAKER_OPEN")
          );
        }
        logger.error("Auth route circuit breaker failure", {
          route: req.path,
          method: req.method,
          error: error instanceof Error ? error.message : String(error),
        });
        next(error);
      }
    };
  };

  const withCircuitBreakerAndWrap = (
    routeName: string,
    handler: AsyncRouteHandler
  ): RequestHandler => {
    return withCircuitBreaker(wrapAuthHandler(routeName, handler, logger));
  };

  router.use(markAuthRouteBase());
  router.use(noStoreAuthResponse());
  router.use(idempotencyMiddleware);

  /** Request timeout guard — prevents slow auth handlers from hanging. */
  const AUTH_REQUEST_TIMEOUT_MS = 15_000;

  const withTimeout = (handler: RequestHandler): RequestHandler => {
    return (req, res, next) => {
      const timer = setTimeout(() => {
        logger.warn("Auth request timed out", {
          route: req.path,
          method: req.method,
          timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
        });
        next(new HttpError(408, "Request timed out", "AUTH_REQUEST_TIMEOUT"));
      }, AUTH_REQUEST_TIMEOUT_MS);
      timer.unref?.();

      const clear = () => clearTimeout(timer);
      res.on("finish", clear);
      res.on("close", clear);

      handler(req, res, (err) => {
        clearTimeout(timer);
        next(err);
      });
    };
  };

  router.get(
    "/challenge",
    challengeRateLimiter,
    validateQuery(challengeQuerySchema),
    withTimeout,
    withCircuitBreakerAndWrap("auth.challenge", controller.challenge as AsyncRouteHandler)
  );

  router.post(
    "/challenge",
    challengeRateLimiter,
    validateBody(challengeBodySchema),
    withTimeout,
    withCircuitBreakerAndWrap("auth.challenge", controller.challenge as AsyncRouteHandler)
  );

  router.post(
    "/verify",
    verifyRateLimiter,
    validateBody(verifySchema),
    withTimeout,
    withCircuitBreakerAndWrap("auth.verify", controller.verify as AsyncRouteHandler)
  );

  router.get(
    "/me",
    authMiddleware,
    wrapAuthHandler("auth.me", controller.me as AsyncRouteHandler, logger)
  );

  return router;
}
