import { Router, type Request, type Response, type NextFunction } from "express";
import { DataSource } from "typeorm";

import { ipWhitelistMiddleware } from "@/middleware/ip-whitelist.middleware";
import type { InvoiceService } from "@/services/invoice.service";
import type { InvoiceExtensionService } from "@/services/invoice-extension.service";
import type { AdminMetricsService } from "@/services/admin-metrics.service";
import { approveKYC } from "./approve-kyc";
import { rejectKYC } from "./reject-kyc";
import { revokeKYC } from "./revoke-kyc";
import { approveInvoice } from "./approve-invoice";
import { rejectInvoice } from "./reject-invoice";
import { ServiceError } from "@/utils/service-error";
import { PublicAppError } from "@/utils/http-error";

export interface AdminRouterDependencies {
  dataSource: DataSource;
  allowedCidrs: string[];
  /** Optional: enables POST /invoices/:id/approve and /invoices/:id/reject.
   *  Omitted deployments (e.g. minimal test apps) simply won't mount them. */
  invoiceService?: InvoiceService;
  /** Issue #477 — admin approval gate for funding deadline extensions. */
  extensionService?: InvoiceExtensionService;
  /** Issue #478 — platform metrics aggregation for the admin dashboard. */
  metricsService?: AdminMetricsService;
}

export function createAdminRouter({
  dataSource,
  allowedCidrs,
  invoiceService,
  extensionService,
  metricsService,
}: AdminRouterDependencies): Router {
  const router = Router();
  const ipWhitelist = ipWhitelistMiddleware(allowedCidrs);

  // Admin-only: IP whitelist is the role gate for this router (issue #478).
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

  // GET /admin/metrics — platform-wide dashboard aggregates (issue #478)
  if (metricsService) {
    router.get("/metrics", async (req: Request, res: Response, next: NextFunction) => {
      try {
        const from =
          typeof req.query.from === "string" && req.query.from
            ? new Date(req.query.from)
            : null;
        const to =
          typeof req.query.to === "string" && req.query.to ? new Date(req.query.to) : null;
        if (from && Number.isNaN(from.getTime())) {
          throw new PublicAppError(400, "Invalid from date", "INVALID_DATE");
        }
        if (to && Number.isNaN(to.getTime())) {
          throw new PublicAppError(400, "Invalid to date", "INVALID_DATE");
        }
        const metrics = await metricsService.getMetrics({ from, to });
        res.setHeader("Cache-Control", "private, max-age=60");
        res.status(200).json({ success: true, data: metrics });
      } catch (error) {
        next(error);
      }
    });
  }

  // PATCH /admin/invoices/:id/extension-request/:reqId — approve/reject (issue #477)
  if (extensionService) {
    router.patch(
      "/invoices/:id/extension-request/:reqId",
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const decisionRaw = String(req.body?.decision ?? "").toLowerCase();
          if (decisionRaw !== "approve" && decisionRaw !== "reject") {
            throw new PublicAppError(
              400,
              'decision must be "approve" or "reject"',
              "INVALID_DECISION"
            );
          }
          const reviewedBy =
            (typeof req.body?.reviewedBy === "string" && req.body.reviewedBy) ||
            (req.ip ?? "admin");

          const result = await extensionService.reviewExtension({
            invoiceId: req.params.id,
            requestId: req.params.reqId,
            decision: decisionRaw,
            reviewedBy,
            reviewNote: typeof req.body?.reviewNote === "string" ? req.body.reviewNote : null,
          });

          res.status(200).json({
            success: true,
            data: {
              request: {
                id: result.request.id,
                status: result.request.status,
                proposedDeadline: result.request.proposedDeadline.toISOString(),
                previousDeadline: result.request.previousDeadline?.toISOString() ?? null,
                reviewedBy: result.request.reviewedBy,
                reviewedAt: result.request.reviewedAt?.toISOString() ?? null,
              },
              invoice: result.invoice
                ? {
                    id: result.invoice.id,
                    fundingDeadline: result.invoice.fundingDeadline?.toISOString() ?? null,
                    status: result.invoice.status,
                  }
                : null,
            },
          });
        } catch (error) {
          if (error instanceof ServiceError) {
            next(new PublicAppError(error.statusCode, error.message, error.code, error.details));
            return;
          }
          next(error);
        }
      }
    );
  }

  return router;
}
