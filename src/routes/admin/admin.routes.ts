import { Router } from "express";
import { DataSource } from "typeorm";

import { ipWhitelistMiddleware } from "@/middleware/ip-whitelist.middleware";
import type { InvoiceService } from "@/services/invoice.service";
import type { AdminSettlementService } from "@/services/admin-settlement.service";
import { approveKYC } from "./approve-kyc";
import { rejectKYC } from "./reject-kyc";
import { revokeKYC } from "./revoke-kyc";
import { approveInvoice } from "./approve-invoice";
import { rejectInvoice } from "./reject-invoice";
import { createAdminSettlementRouter } from "./settlement.routes";

export interface AdminRouterDependencies {
  dataSource: DataSource;
  allowedCidrs: string[];
  /** Optional: enables POST /invoices/:id/approve and /invoices/:id/reject.
   *  Omitted deployments (e.g. minimal test apps) simply won't mount them. */
  invoiceService?: InvoiceService;
  /** Optional: enables POST /invoices/:invoiceId/settle for admin settlement. */
  adminSettlementService?: AdminSettlementService;
}

export function createAdminRouter({
  dataSource,
  allowedCidrs,
  invoiceService,
  adminSettlementService,
}: AdminRouterDependencies): Router {
  const router = Router();
  const ipWhitelist = ipWhitelistMiddleware(allowedCidrs);

  router.use(ipWhitelist);

  router.post("/approve-kyc", (req, res) => {
    approveKYC(req, res, dataSource);
  });

  router.post("/reject-kyc", (req, res) => {
    rejectKYC(req, res, dataSource);
  });

  router.post("/revoke-kyc", (req, res) => {
    revokeKYC(req, res, dataSource);
  });

  if (invoiceService) {
    router.post("/invoices/:id/approve", (req, res) => {
      approveInvoice(req, res, invoiceService);
    });

    router.post("/invoices/:id/reject", (req, res) => {
      rejectInvoice(req, res, invoiceService);
    });
  }

  if (adminSettlementService) {
    router.use("/invoices", createAdminSettlementRouter({ adminSettlementService }));
  }

  return router;
}
