import type { Server } from "http";

import { createApp } from "./app";

import dataSource from "./config/database";
import { getConfig } from "./config/env";
import { logger } from "./observability/logger";

import { createAuthService } from "./services/auth.service";
import { createNotificationService } from "./services/notification.service";
import { createInvoiceService } from "./services/invoice.service";
import { createIPFSService } from "./services/ipfs.service";

export async function bootstrap(): Promise<{ server: Server }> {
  const config = getConfig();

  if (!dataSource.isInitialized) {
    await dataSource.initialize();
  }

  const authService = createAuthService(dataSource, config);
  const notificationService = createNotificationService(dataSource);
  const ipfsService = createIPFSService(config.ipfs);
  const invoiceService = createInvoiceService(dataSource, ipfsService);

  const app = createApp({
    authService,
    notificationService,
    invoiceService,
    ipfsConfig: config.ipfs,
    logger,
    metricsEnabled: config.observability.metricsEnabled,
  });

  const server = app.listen(config.port, () => {
    logger.info("Server running", { port: config.port });
  });

  return { server };
}

if (require.main === module) {
  bootstrap().catch((err) => {
    logger.error("Startup failed", { error: err });
    process.exit(1);
  });
}
