import cors from "cors";
import express from "express";
import helmet from "helmet";
import { createErrorMiddleware, notFoundMiddleware } from "./middleware/error.middleware";
import { createRequestObservabilityMiddleware } from "./middleware/request-observability.middleware";
import { logger, type AppLogger } from "./observability/logger";
import { getMetricsContentType, MetricsRegistry } from "./observability/metrics";
import { createAuthRouter } from "./routes/auth.routes";
import { createNotificationRouter } from "./routes/notification.routes";
import type { AuthService } from "./services/auth.service";
import type { NotificationService } from "./services/notification.service";

export interface AppDependencies {
  authService: AuthService;
  notificationService?: NotificationService;
  logger?: AppLogger;
  metricsEnabled?: boolean;
  metricsRegistry?: MetricsRegistry;
}

export function createApp({
  authService,
  notificationService,
  logger: appLogger = logger,
  metricsEnabled = true,
  metricsRegistry = new MetricsRegistry(),
}: AppDependencies) {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.use(
    createRequestObservabilityMiddleware({
      logger: appLogger,
      metricsEnabled,
      metricsRegistry,
    }),
  );

  app.get("/health", (req, res) => {
    res.status(200).json({
      status: "ok",
      uptimeSeconds: Number(process.uptime().toFixed(3)),
      requestId: req.requestId,
    });
  });

  if (metricsEnabled) {
    app.get("/metrics", (_req, res) => {
      res.setHeader("Content-Type", getMetricsContentType());
      res.status(200).send(metricsRegistry.renderPrometheusMetrics());
    });
  }

  app.use("/api/v1/auth", createAuthRouter(authService));

  if (notificationService) {
    app.use(
      "/api/v1/notifications",
      createNotificationRouter(notificationService, authService),
    );
  }

  app.use(notFoundMiddleware);
  app.use(createErrorMiddleware(appLogger));

  return app;
}