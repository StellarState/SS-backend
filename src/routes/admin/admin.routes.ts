import { Router } from "express";
import { DataSource } from "typeorm";

import { ipWhitelistMiddleware } from "@/middleware/ip-whitelist.middleware";
import type { InvoiceService } from "@/services/invoice.service";
import { approveKYC } from "./approve-kyc";
import { rejectKYC } from "./reject-kyc";
import { revokeKYC } from "./revoke-kyc";

export interface AdminRouterDependencies {
  dataSource: DataSource;
  allowedCidrs: string[];
  /** Optional: enables POST /invoices/:id/reject. Omitted deployments
   *  (e.g. minimal test apps) simply won't mount that route. */
  invoiceService?: InvoiceService;
}

export function createAdminRouter({
  dataSource,
  allowedCidrs,
  // Not wired up yet: `./reject-invoice.ts` (POST /invoices/:id/reject)
  // exists but isn't mounted here, and itself calls an
  // `InvoiceService.rejectInvoice` that doesn't exist yet either. Out of
  // scope for this change; kept as a documented no-op rather than silently
  // dropped so the next person wiring it up has a marker to find.
  invoiceService: _invoiceService,
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

  return router;
}