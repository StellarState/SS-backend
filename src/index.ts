import type { Server } from "http";
import { createApp, createRequestLifecycleTracker } from "./app";
import dataSource from "./config/database";
import { getConfig } from "./config/env";
import { getPaymentVerificationConfig } from "./config/stellar";
import { logger } from "./observability/logger";
import { createAuthService } from "./services/auth.service";
import { createVerifyPaymentService } from "./services/stellar/verify-payment.service";
import { createReconcilePendingStellarStateWorker } from "./workers/reconcile-pending-stellar-state.worker";

export interface ApplicationRuntime {
  stop(signal?: string): Promise<void>;
  server: Server;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function waitForTimeout(timeoutMs: number): Promise<false> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(false), timeoutMs);
  });
}

export async function bootstrap(): Promise<ApplicationRuntime> {
  const config = getConfig();

  if (!dataSource.isInitialized) {
    await dataSource.initialize();
  }

  const authService = createAuthService(dataSource, config);
  const requestLifecycleTracker = createRequestLifecycleTracker();
  const app = createApp({
    authService,
    logger,
    metricsEnabled: config.observability.metricsEnabled,
    http: {
      trustProxy: config.http.trustProxy,
      corsAllowedOrigins: config.http.corsAllowedOrigins,
      corsAllowCredentials: config.http.corsAllowCredentials,
      bodySizeLimit: config.http.bodySizeLimit,
      nodeEnv: config.nodeEnv,
    },
    requestLifecycleTracker,
  });
  const server = await new Promise<Server>((resolve) => {
    const listeningServer = app.listen(config.port, () => {
      logger.info("StellarSettle API listening.", {
        port: config.port,
        metricsEnabled: config.observability.metricsEnabled,
      });
      resolve(listeningServer);
    });
  });

  const reconciliationWorker = config.reconciliation.enabled
    ? createReconcilePendingStellarStateWorker(
        dataSource,
        createVerifyPaymentService(dataSource, getPaymentVerificationConfig()),
        config.reconciliation,
        logger,
      )
    : null;

  reconciliationWorker?.start();

  let shutdownPromise: Promise<void> | null = null;

  const stop = async (signal = "manual"): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      logger.info("Shutting down StellarSettle API.", { signal });
      const closePromise = closeServer(server);
      const drained = await Promise.race([
        requestLifecycleTracker.waitForDrain(config.http.shutdownTimeoutMs),
        waitForTimeout(config.http.shutdownTimeoutMs),
      ]);

      if (!drained) {
        logger.warn("HTTP shutdown grace period elapsed with requests still in flight.", {
          signal,
          timeoutMs: config.http.shutdownTimeoutMs,
        });
      }

      await reconciliationWorker?.stop();
      await Promise.race([closePromise, waitForTimeout(config.http.shutdownTimeoutMs)]);

      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }

      logger.info("StellarSettle API stopped.", { signal });
    })();

    return shutdownPromise;
  };

  process.once("SIGTERM", () => {
    void stop("SIGTERM");
  });
  process.once("SIGINT", () => {
    void stop("SIGINT");
  });

  return {
    stop,
    server,
  };
}

if (require.main === module) {
  void bootstrap().catch((error: unknown) => {
    logger.error("Failed to bootstrap StellarSettle API.", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    process.exitCode = 1;
  });
}
