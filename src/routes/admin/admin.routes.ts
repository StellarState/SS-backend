import { Router } from "express";
import { DataSource } from "typeorm";

import { ipWhitelistMiddleware } from "@/middleware/ip-whitelist.middleware";
import { createAuthMiddleware, requireAdmin } from "@/middleware/auth.middleware";
import type { InvoiceService } from "@/services/invoice.service";
import type { AuthService } from "@/services/auth.service";
import type { InvoiceEscrowContractService } from "@/services/stellar/invoice-escrow-contract.service";

import { approveKYC } from "./approve-kyc";
import { rejectKYC } from "./reject-kyc";
import { revokeKYC } from "./revoke-kyc";
import { approveInvoice } from "./approve-invoice";
import { rejectInvoice } from "./reject-invoice";
import { listInvoices } from "./list-invoices";
import { reviewInvoice } from "./review-invoice";

export interface AdminRouterDependencies {
  dataSource: DataSource;
  allowedCidrs: string[];
  invoiceService?: InvoiceService;
  authService?: AuthService;
  adminWallets?: string[];
  invoiceEscrowContractService?: InvoiceEscrowContractService;
}

export function createAdminRouter({
  dataSource,
  allowedCidrs,
  invoiceService,
  authService,
  adminWallets = [],
  invoiceEscrowContractService
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
    // Legacy x-admin-key routes
    router.post("/invoices/:id/approve", (req, res) => {
      approveInvoice(req, res, invoiceService);
    });

    router.post("/invoices/:id/reject", (req, res) => {
      rejectInvoice(req, res, invoiceService);
    });

    // New JWT-authenticated admin routes for invoices
    if (authService) {
      const authenticateJWT = createAuthMiddleware(authService);
      const requireAdminJWT = requireAdmin(adminWallets);

      router.get(
        "/invoices",
        authenticateJWT as any,
        requireAdminJWT as any,
        (req, res) => {
          listInvoices(req, res, invoiceService);
        }
      );

      router.patch(
        "/invoices/:invoiceId",
        authenticateJWT as any,
        requireAdminJWT as any,
        (req, res) => {
          reviewInvoice(req, res, invoiceService, invoiceEscrowContractService);
        }
      );
    }
  }

  return router;
}
