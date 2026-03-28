import cors from "cors";
import express from "express";
import helmet from "helmet";
import { createErrorMiddleware, notFoundMiddleware } from "./middleware/error.middleware";
import { applyRateLimiters, createAuthRateLimitMiddleware } from "./middleware/rate-limit.middleware";
import { createRequestObservabilityMiddleware } from "./middleware/request-observability.middleware";
import { logger, type AppLogger } from "./observability/logger";
import { getMetricsContentType, MetricsRegistry } from "./observability/metrics";
import { createAuthRouter } from "./routes/auth.routes";
import { createInvoiceRouter } from "./routes/invoice.routes";
import type { AuthService } from "./services/auth.service";
import type { ApiResponseEnvelope } from "./utils/http-error";
import dataSource from "./config/database";
import type { InvoiceService } from "./services/invoice.service";
import type { AppConfig } from "./config/env";

export interface AppDependencies {
  authService: AuthService;
  invoiceService?: InvoiceService;
  logger?: AppLogger;
  metricsEnabled?: boolean;
  metricsRegistry?: MetricsRegistry;
  http?: {
    trustProxy?: boolean | number | string;
    corsAllowedOrigins?: string[];
    corsAllowCredentials?: boolean;
    bodySizeLimit?: string;
    nodeEnv?: string;
    rateLimit?: {
      enabled?: boolean;
      windowMs?: number;
      max?: number;
    };
  };
  ipfsConfig?: AppConfig["ipfs"];
  requestLifecycleTracker?: RequestLifecycleTracker;
}

export interface RequestLifecycleTracker {
  onRequestStart(): void;
  onRequestEnd(): void;
  waitForDrain(timeoutMs: number): Promise<boolean>;
}

function createCorsOptions({
  allowedOrigins,
  allowCredentials,
  nodeEnv,
}: {
  allowedOrigins: string[];
  allowCredentials: boolean;
  nodeEnv: string;
}): cors.CorsOptions {
  return {
    credentials: allowCredentials,
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      if (nodeEnv !== "production" && allowedOrigins.length === 0) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
  };
}

export function createRequestLifecycleTracker(): RequestLifecycleTracker {
  let activeRequests = 0;
  let drainResolvers: Array<(drained: boolean) => void> = [];

  const resolveDrainIfIdle = () => {
    if (activeRequests !== 0) {
      return;
    }

    const resolvers = drainResolvers;
    drainResolvers = [];
    resolvers.forEach((resolve) => resolve(true));
  };

  return {
    onRequestStart() {
      activeRequests += 1;
    },
    onRequestEnd() {
      activeRequests = Math.max(0, activeRequests - 1);
      resolveDrainIfIdle();
    },
    waitForDrain(timeoutMs: number) {
      if (activeRequests === 0) {
        return Promise.resolve(true);
      }

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          drainResolvers = drainResolvers.filter((item) => item !== resolve);
          resolve(false);
        }, timeoutMs);

        drainResolvers.push((drained) => {
          clearTimeout(timeout);
          resolve(drained);
        });
      });
    },
  };
}

export function createApp({
  authService,
  invoiceService,
  logger: appLogger = logger,
  metricsEnabled = true,
  metricsRegistry = new MetricsRegistry(),
  http,
  ipfsConfig,
  requestLifecycleTracker = createRequestLifecycleTracker(),
}: AppDependencies) {
  const app = express();
  const corsAllowedOrigins = http?.corsAllowedOrigins ?? [];
  const corsAllowCredentials = http?.corsAllowCredentials ?? true;
  const bodySizeLimit = http?.bodySizeLimit ?? "1mb";
  const trustProxy = http?.trustProxy ?? false;
  const nodeEnv = http?.nodeEnv ?? process.env.NODE_ENV ?? "development";
  const rateLimitEnabled = http?.rateLimit?.enabled ?? true;

  app.set("trust proxy", trustProxy);
  app.use(helmet());
  app.use(
    cors(
      createCorsOptions({
        allowedOrigins: corsAllowedOrigins,
        allowCredentials: corsAllowCredentials,
        nodeEnv,
      }),
    ),
  );
  app.use(express.json({ limit: bodySizeLimit }));
  
  if (rateLimitEnabled) {
    applyRateLimiters(app, appLogger, {
      global: {
        windowMs: http?.rateLimit?.windowMs,
        max: http?.rateLimit?.max,
      },
    });
  }
  
  app.use((req, res, next) => {
    requestLifecycleTracker.onRequestStart();
    const finalize = () => {
      res.off("finish", finalize);
      res.off("close", finalize);
      requestLifecycleTracker.onRequestEnd();
    };

    res.on("finish", finalize);
    res.on("close", finalize);
    next();
  });
  app.use(
    createRequestObservabilityMiddleware({
      logger: appLogger,
      metricsEnabled,
      metricsRegistry,
    }),
  );

  app.get("/health", (req, res) => {
    const envelope: ApiResponseEnvelope<{ status: string; timestamp: string; uptimeSeconds: number; requestId: string }> = {
      success: true,
      data: {
        status: "ok",
        timestamp: new Date().toISOString(),
        uptimeSeconds: Number(process.uptime().toFixed(3)),
        requestId: req.requestId ?? "unknown",
      },
    };
    res.status(200).json(envelope);
  });

  app.get("/health/db", async (req, res) => {
    try {
      if (!dataSource.isInitialized) {
        const envelope: ApiResponseEnvelope<{ requestId: string }> = {
          success: false,
          error: {
            code: "DB_NOT_INITIALIZED",
            message: "Database connection is not initialized.",
          },
          data: {
            requestId: req.requestId ?? "unknown",
          },
        };
        res.status(503).json(envelope);
        return;
      }

      await dataSource.query("SELECT 1");
      
      const envelope: ApiResponseEnvelope<{ status: string; timestamp: string; connection: string; requestId: string }> = {
        success: true,
        data: {
          status: "ok",
          timestamp: new Date().toISOString(),
          connection: "postgres",
          requestId: req.requestId ?? "unknown",
        },
      };
      res.status(200).json(envelope);
    } catch (error) {
      const envelope: ApiResponseEnvelope<{ requestId: string }> = {
        success: false,
        error: {
          code: "DB_CONNECTION_ERROR",
          message: "Database connection failed.",
        },
        data: {
          requestId: req.requestId ?? "unknown",
        },
      };
      res.status(503).json(envelope);
    }
  });

  if (metricsEnabled) {
    app.get("/metrics", (_req, res) => {
      res.setHeader("Content-Type", getMetricsContentType());
      res.status(200).send(metricsRegistry.renderPrometheusMetrics());
    });
  }

  const authRouter = createAuthRouter(authService);
  if (rateLimitEnabled) {
    authRouter.use(createAuthRateLimitMiddleware(appLogger));
  }
  app.use("/api/v1/auth", authRouter);

  // Add invoice routes if service is provided
  if (invoiceService && ipfsConfig) {
    app.use("/api/v1/invoices", createInvoiceRouter({
      invoiceService,
      config: ipfsConfig,
    }));
  }

  app.use(notFoundMiddleware);
  app.use(createErrorMiddleware(appLogger));
  app.locals.requestLifecycleTracker = requestLifecycleTracker;

  return app;
}
