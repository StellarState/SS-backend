import type { Server } from "http";

import { createApp } from "./app";

import dataSource from "./config/database";
import { getConfig } from "./config/env";
import { logger } from "./observability/logger";

import { createAuthService } from "./services/auth.service";
import { createNotificationService } from "./services/notification.service";
import { createInvoiceService } from "./services/invoice.service";
import { createIPFSService } from "./services/ipfs.service";
import { createInvestmentService } from "./services/investment.service";
import { createSettlementService } from "./services/settlement.service";
import { createAcknowledgementService } from "./services/acknowledgement.service";
import { createExtensionRequestService } from "./services/extension-request.service";
import { createPortfolioService } from "./services/portfolio.service";

export async function bootstrap(): Promise<{ server: Server }> {
  const config = getConfig();

  if (!dataSource.isInitialized) {
    await dataSource.initialize();
  }

  const authService = createAuthService(dataSource, config);
  const notificationService = createNotificationService(dataSource);
  const ipfsService = createIPFSService(config.ipfs, logger);
  const invoiceService = createInvoiceService(dataSource, ipfsService);
  const investmentService = createInvestmentService(dataSource);
  const settlementService = createSettlementService(dataSource);
  const acknowledgementService = createAcknowledgementService(dataSource);
  const extensionRequestService = createExtensionRequestService(dataSource, notificationService);
  const portfolioService = createPortfolioService(dataSource);

  const app = createApp({
    authService,
    notificationService,
    invoiceService,
    investmentService,
    settlementService,
    acknowledgementService,
    extensionRequestService,
    portfolioService,
    config,
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
