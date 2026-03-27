import cors from "cors";
import express from "express";
import helmet from "helmet";
import { createErrorMiddleware, notFoundMiddleware } from "./middleware/error.middleware";
import { createRequestObservabilityMiddleware } from "./middleware/request-observability.middleware";
import { logger, type AppLogger } from "./observability/logger";
import { getMetricsContentType, MetricsRegistry } from "./observability/metrics";
import { createAuthRouter } from "./routes/auth.routes";
import type { AuthService } from "./services/auth.service";

export interface AppDependencies {
  authService: AuthService;
  logger?: AppLogger;
  metricsEnabled?: boolean;
  metricsRegistry?: MetricsRegistry;
  http?: {
    trustProxy?: boolean | number | string;
    corsAllowedOrigins?: string[];
    corsAllowCredentials?: boolean;
    bodySizeLimit?: string;
    nodeEnv?: string;
  };
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
  logger: appLogger = logger,
  metricsEnabled = true,
  metricsRegistry = new MetricsRegistry(),
  http,
  requestLifecycleTracker = createRequestLifecycleTracker(),
}: AppDependencies) {
  const app = express();
  const corsAllowedOrigins = http?.corsAllowedOrigins ?? [];
  const corsAllowCredentials = http?.corsAllowCredentials ?? true;
  const bodySizeLimit = http?.bodySizeLimit ?? "1mb";
  const trustProxy = http?.trustProxy ?? false;
  const nodeEnv = http?.nodeEnv ?? process.env.NODE_ENV ?? "development";

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

  app.use(notFoundMiddleware);
  app.use(createErrorMiddleware(appLogger));
  app.locals.requestLifecycleTracker = requestLifecycleTracker;

  return app;
}
