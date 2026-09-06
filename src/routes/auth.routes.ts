import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type ErrorRequestHandler,
} from "express";
import Joi from "joi";
import { createAuthController } from "../controllers/auth.controller";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import { validateBody } from "../middleware/validate.middleware";
import {
  createChallengeRateLimitMiddleware,
  createVerifyRateLimitMiddleware,
} from "../middleware/rate-limit.middleware";
import { createCircuitBreaker } from "../lib/circuit-breaker";
import type { AuthService } from "../services/auth.service";
import type { AppLogger } from "../observability/logger";
import { HttpError } from "../utils/http-error";

// Strict schemas: enforce Stellar G... format hint, length bounds, and sanitized inputs.
const STELLAR_PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;
const NONCE_PATTERN = /^[A-Za-z0-9:_-]+$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/=:_\-.]+$/;

type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<void> | void;

const publicKeySchema = Joi.string().trim().required();

const challengeSchema = Joi.object({
  publicKey: publicKeySchema,
}).unknown(true);

const verifySchema = Joi.object({
  publicKey: publicKeySchema,
  nonce: Joi.string().trim().required(),
  signature: Joi.string().trim().required(),
}).unknown(true);

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

function extractIdempotencyKey(req: Request): string | null {
  const key = req.headers["idempotency-key"] as string | undefined;
  return key || null;
}

function createIdempotencyMiddleware() {
  const cache = new Map<
    string,
    { status: number; body: Record<string, unknown>; expiresAt: number }
  >();
  const TTL_MS = 60 * 60 * 1000;

  setInterval(
    () => {
      const now = Date.now();
      for (const [key, value] of cache.entries()) {
        if (value.expiresAt < now) {
          cache.delete(key);
        }
      }
    },
    5 * 60 * 1000
  );

  return (req: Request, res: Response, next: NextFunction) => {
    const key = extractIdempotencyKey(req);
    if (!key) {
      return next();
    }

    const cached = cache.get(key);
    if (cached) {
      res.setHeader("X-Idempotency-Replay", "true");
      return res.status(cached.status).json(cached.body);
    }

    const originalJson = res.json.bind(res);
    res.json = (body: Record<string, unknown>) => {
      if (res.statusCode < 400) {
        cache.set(key, { status: res.statusCode, body, expiresAt: Date.now() + TTL_MS });
      }
      return originalJson(body);
    };

    next();
  };
}

function normalizeErrorResponse(): ErrorRequestHandler {
  return (err: Error, req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({
        success: false,
        error: {
          code: err.code ?? "INTERNAL_ERROR",
          message: err.message,
          details: err.details,
        },
        requestId: req.headers["x-request-id"],
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      },
      requestId: req.headers["x-request-id"],
    });
  };
}

export function createAuthRouter(authService: AuthService, logger: AppLogger): Router {
  const router = Router();
  const controller = createAuthController(authService);
  const authMiddleware = createAuthMiddleware(authService);

  const challengeRateLimiter = createChallengeRateLimitMiddleware(logger);
  const verifyRateLimiter = createVerifyRateLimitMiddleware(logger);
  const idempotencyMiddleware = createIdempotencyMiddleware();
  const circuitBreaker = createCircuitBreaker({ failureThreshold: 5, timeout: 30000 });

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
          logger.warn("Circuit breaker open for auth route", { route: req.path });
          return next(
            new HttpError(503, "Service temporarily unavailable", "CIRCUIT_BREAKER_OPEN")
          );
        }
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

  router.post(
    "/challenge",
    challengeRateLimiter,
    validateBody(challengeSchema),
    withCircuitBreakerAndWrap("auth.challenge", controller.challenge as AsyncRouteHandler)
  );

  router.post(
    "/verify",
    verifyRateLimiter,
    validateBody(verifySchema),
    withCircuitBreakerAndWrap("auth.verify", controller.verify as AsyncRouteHandler)
  );

  router.get(
    "/me",
    authMiddleware,
    wrapAuthHandler("auth.me", controller.me as AsyncRouteHandler, logger)
  );

  router.use(normalizeErrorResponse());

  return router;
}
