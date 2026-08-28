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
  // Not yet wired to a route (see AdminRouterDependencies.invoiceService doc
  // comment); kept as a named param so callers can pass it in ahead of that
  // route landing, without the lint no-unused-vars check tripping on it.
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