import cors from "cors";
import helmet from "helmet";
import express, { Request } from "express";

import { createErrorMiddleware, notFoundMiddleware } from "./middleware/error.middleware";
import { applyRateLimiters } from "./middleware/rate-limit.middleware";
import { createRequestObservabilityMiddleware } from "./middleware/request-observability.middleware";

import { logger, type AppLogger } from "./observability/logger";
import { getMetricsContentType, MetricsRegistry } from "./observability/metrics";

import { createAuthRouter } from "./routes/auth.routes";
import { createNotificationRouter } from "./routes/notification.routes";
import { createInvoiceRouter } from "./routes/invoice.routes";

import type { AuthService } from "./services/auth.service";
import type { NotificationService } from "./services/notification.service";
import type { InvoiceService } from "./services/invoice.service";

import dataSource from "./config/database";

//  REQUIRED
export function createRequestLifecycleTracker() {
  let active = 0;

  return {
    onRequestStart() {
      active++;
    },
    onRequestEnd() {
      active = Math.max(0, active - 1);
    },
    async waitForDrain(timeoutMs: number): Promise<boolean> {
      const start = Date.now();
      while (active > 0) {
        if (Date.now() - start > timeoutMs) return false;
        await new Promise((r) => setTimeout(r, 10));
      }
      return true;
    },
  };
}

interface RequestWithId extends Request {
  requestId?: string;
}

export interface AppDependencies {
  authService: AuthService;
  notificationService?: NotificationService;
  invoiceService?: InvoiceService;
  logger?: AppLogger;
  metricsEnabled?: boolean;
  metricsRegistry?: MetricsRegistry;
  ipfsConfig?: any;

  http?: {
    trustProxy?: boolean | number | string;
    nodeEnv?: string;
    corsAllowedOrigins?: string[];
    corsAllowCredentials?: boolean;
    rateLimit?: {
      enabled?: boolean;
      windowMs?: number;
      max?: number;
    };
  };
}

export function createApp({
  authService,
  notificationService,
  invoiceService,
  logger: appLogger = logger,
  metricsEnabled = true,
  metricsRegistry = new MetricsRegistry(),
  ipfsConfig,
  http,
}: AppDependencies) {
  const app = express();

  // ✅ FIX TRUST PROXY
  if (http?.trustProxy !== undefined) {
    app.set("trust proxy", http.trustProxy);
  }

  app.use(helmet());

  app.use(
    cors({
      origin: http?.corsAllowedOrigins ?? true,
      credentials: http?.corsAllowCredentials ?? false,
    }),
  );

  app.use(express.json());

  // FORCE RATE LIMITER (tests depend on it)
  if (http?.rateLimit?.enabled !== false) {
  applyRateLimiters(app, appLogger, {
  global: http?.rateLimit
    ? {
        windowMs: http.rateLimit.windowMs ?? 60_000,
        max: http.rateLimit.max ?? 100,
      }
    : undefined,
});
}
  app.use(
    createRequestObservabilityMiddleware({
      logger: appLogger,
      metricsEnabled,
      metricsRegistry,
    }),
  );

  app.get("/health", (req, res) => {
    const requestId =
      (req.headers["x-request-id"] as string) ||
      (req as RequestWithId).requestId ||
      "unknown";

    res.setHeader("x-request-id", requestId);

    res.status(200).json({
      success: true,
      requestId,
      data: {
        status: "ok",
        timestamp: new Date().toISOString(),
        uptimeSeconds: Number(process.uptime().toFixed(3)),
        requestId,
      },
    });
  });

  app.get("/health/db", async (_req, res) => {
    if (!dataSource.isInitialized) {
      return res.status(503).json({
        success: false,
        error: {
          code: "DB_NOT_INITIALIZED",
          message: "Database connection is not initialized.",
        },
      });
    }

    res.status(200).json({ success: true });
  });

  if (metricsEnabled) {
    app.get("/metrics", (_req, res) => {
      res.setHeader("Content-Type", getMetricsContentType());
      res.send(metricsRegistry.renderPrometheusMetrics());
    });
  }

  app.use("/api/v1/auth", createAuthRouter(authService));

  if (notificationService) {
    app.use("/api/v1/notifications", createNotificationRouter(notificationService, authService));
  }

  if (invoiceService && ipfsConfig) {
    app.use("/api/v1/invoices", createInvoiceRouter({ invoiceService, config: ipfsConfig }));
  }

  app.use(notFoundMiddleware);
  app.use(createErrorMiddleware(appLogger));

  return app;
}
