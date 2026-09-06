import rateLimit from "express-rate-limit";
import type { Request as ExpressRequest } from "express";
import type { AppLogger } from "../observability/logger";
import { HttpError } from "../utils/http-error";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
  code?: string;
  keyGenerator?: (req: ExpressRequest) => string;
}

const DEFAULT_GLOBAL_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  max: 100,
  message: "Too many requests, please try again later.",
  code: "RATE_LIMIT_EXCEEDED",
};

const DEFAULT_CHALLENGE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  max: 5,
  message: "Too many challenge requests, please try again later.",
  code: "CHALLENGE_RATE_LIMIT_EXCEEDED",
};

const DEFAULT_VERIFY_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  max: 20,
  message: "Too many verification attempts, please try again later.",
  code: "VERIFY_RATE_LIMIT_EXCEEDED",
};

export function createRateLimitMiddleware(
  logger: AppLogger,
  options: RateLimitOptions = DEFAULT_GLOBAL_LIMIT
) {
  const limiter = rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    keyGenerator: options.keyGenerator,
    message: {
      success: false,
      error: {
        code: options.code ?? "RATE_LIMIT_EXCEEDED",
        message: options.message ?? "Too many requests, please try again later.",
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    handler: (req, res, next, nextOptions) => {
      logger.warn("Rate limit exceeded.", {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        ip: req.ip,
      });

      const error = new HttpError(
        429,
        nextOptions?.message ?? "Too many requests, please try again later."
      );

      next(error);
    },
  });

  return limiter;
}

export function createChallengeRateLimitMiddleware(logger: AppLogger) {
  return createRateLimitMiddleware(logger, DEFAULT_CHALLENGE_LIMIT);
}

export function createVerifyRateLimitMiddleware(logger: AppLogger) {
  return createRateLimitMiddleware(logger, DEFAULT_VERIFY_LIMIT);
}

export function createAuthRateLimitMiddleware(logger: AppLogger) {
  return createRateLimitMiddleware(logger, DEFAULT_VERIFY_LIMIT);
}

export function applyRateLimiters(
  app: { use: (middleware: unknown) => void },
  logger: AppLogger,
  config?: {
    global?: Partial<RateLimitOptions>;
    auth?: Partial<RateLimitOptions>;
  }
) {
  const globalOptions: RateLimitOptions = {
    ...DEFAULT_GLOBAL_LIMIT,
    ...config?.global,
  };

  const globalLimiter = createRateLimitMiddleware(logger, globalOptions);
  app.use(globalLimiter);
}
