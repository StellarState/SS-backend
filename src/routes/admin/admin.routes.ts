import { Router } from "express";
import { DataSource } from "typeorm";

import { ipWhitelistMiddleware } from "@/middleware/ip-whitelist.middleware";
import type { InvoiceService } from "@/services/invoice.service";
import type { AuthService } from "@/services/auth.service";
import type { AdminUserService } from "@/services/admin-user.service";
import { createAdminUsersRouter } from "./users.routes";
import { approveKYC } from "./approve-kyc";
import { rejectKYC } from "./reject-kyc";
import { revokeKYC } from "./revoke-kyc";
import { approveInvoice } from "./approve-invoice";
import { rejectInvoice } from "./reject-invoice";

export interface AdminRouterDependencies {
  dataSource: DataSource;
  allowedCidrs: string[];
  /** Optional: enables POST /invoices/:id/approve and /invoices/:id/reject.
   *  Omitted deployments (e.g. minimal test apps) simply won't mount them. */
  invoiceService?: InvoiceService;
  /** Optional: enables the /users management endpoints (admin JWT required). */
  adminUserService?: AdminUserService;
  authService?: AuthService;
}

export function createAdminRouter({
  dataSource,
  allowedCidrs,
  invoiceService,
  adminUserService,
  authService,
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

  if (adminUserService && authService) {
    router.use("/users", createAdminUsersRouter(adminUserService, authService));
  }

  return router;
}
