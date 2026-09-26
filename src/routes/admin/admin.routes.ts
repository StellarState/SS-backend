import { Router } from "express";
import { DataSource } from "typeorm";

import { ipWhitelistMiddleware } from "@/middleware/ip-whitelist.middleware";
import { createAuthMiddleware } from "@/middleware/auth.middleware";
import { requireAdminRole } from "@/middleware/require-admin-role.middleware";
import type { AuthService } from "@/services/auth.service";
import type { AclService } from "@/services/acl.service";
import type { InvoiceService } from "@/services/invoice.service";
import { approveKYC } from "./approve-kyc";
import { rejectKYC } from "./reject-kyc";
import { revokeKYC } from "./revoke-kyc";
import { approveInvoice } from "./approve-invoice";
import { rejectInvoice } from "./reject-invoice";
import { createAclController } from "./acl";

export interface AdminRouterDependencies {
  dataSource: DataSource;
  allowedCidrs: string[];
  /** Optional: enables POST /invoices/:id/approve and /invoices/:id/reject.
   *  Omitted deployments (e.g. minimal test apps) simply won't mount them. */
  invoiceService?: InvoiceService;
  /** Optional: enables GET /acl and GET /acl/log. */
  aclService?: AclService;
  /** Required for the role-gated ACL endpoints. */
  authService?: AuthService;
}

export function createAdminRouter({
  dataSource,
  allowedCidrs,
  invoiceService,
  aclService,
  authService,
}: AdminRouterDependencies): Router {
  const router = Router();

  // An empty allow-list means "no IP restriction configured"; gating on it
  // would reject every caller, so the middleware is only mounted when the
  // operator actually configured CIDRs.
  if (allowedCidrs.length > 0) {
    router.use(ipWhitelistMiddleware(allowedCidrs));
  }

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

  if (aclService) {
    const aclController = createAclController(aclService);
    // Admin-only: role middleware only applies when the app can authenticate
    // requests at all; without an authService the router is already protected
    // by the IP allow-list above.
    const adminOnly = authService ? [createAuthMiddleware(authService), requireAdminRole()] : [];

    router.get("/acl", ...adminOnly, aclController.getAcl);
    router.get("/acl/log", ...adminOnly, aclController.getAclLog);
  }

  return router;
}
