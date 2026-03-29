import rateLimit from "express-rate-limit";
import type { AppLogger } from "../observability/logger";
import { HttpError } from "../utils/http-error";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
  code?: string;
}

const DEFAULT_GLOBAL_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  max: 100,
  message: "Too many requests, please try again later.",
  code: "RATE_LIMIT_EXCEEDED",
};

const DEFAULT_AUTH_LIMIT: RateLimitOptions = {
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many authentication attempts, please try again later.",
  code: "AUTH_RATE_LIMIT_EXCEEDED",
};

export function createRateLimitMiddleware(
  logger: AppLogger,
  options: RateLimitOptions = DEFAULT_GLOBAL_LIMIT,
) {
  const limiter = rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    message: {
      success: false,
      error: {
        code: options.code ?? "RATE_LIMIT_EXCEEDED",
        message: options.message ?? "Too many requests, please try again later.",
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, nextOptions) => {
      logger.warn("Rate limit exceeded.", {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        ip: req.ip,
      });

      const error = new HttpError(
        429,
        nextOptions?.message ?? "Too many requests, please try again later.",
      );

      next(error);
    },
  });

  return limiter;
}

export function createAuthRateLimitMiddleware(logger: AppLogger) {
  return createRateLimitMiddleware(logger, DEFAULT_AUTH_LIMIT);
}

export function applyRateLimiters(
  app: { use: (middleware: unknown) => void },
  logger: AppLogger,
  config?: {
    global?: Partial<RateLimitOptions>;
    auth?: Partial<RateLimitOptions>;
  },
) {
  const globalOptions: RateLimitOptions = {
    ...DEFAULT_GLOBAL_LIMIT,
    ...config?.global,
  };

  const globalLimiter = createRateLimitMiddleware(logger, globalOptions);
  app.use(globalLimiter);
}
