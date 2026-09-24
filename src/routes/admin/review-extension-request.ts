import { Request, Response } from "express";
import { ExtensionRequestService } from "@/services/extension-request.service";
import { ServiceError } from "@/utils/service-error";
import { logger } from "@/observability/logger";

interface ReviewExtensionRequestBody {
  reviewerId: string;
  approve: boolean;
  rejectionReason?: string;
}

interface ReviewExtensionRequestParams {
  id: string; // invoice id
  reqId: string; // extension request id
}

// PATCH /admin/invoices/:id/extension-request/:reqId
export async function reviewExtensionRequest(
  req: Request<ReviewExtensionRequestParams, unknown, ReviewExtensionRequestBody>,
  res: Response,
  extensionRequestService: ExtensionRequestService,
) {
  try {
    const adminKey = req.headers["x-admin-key"];
    if (adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id: invoiceId, reqId: requestId } = req.params;
    const { reviewerId, approve, rejectionReason } = req.body;

    const result = await extensionRequestService.reviewExtension({
      invoiceId,
      requestId,
      reviewerId,
      approve,
      rejectionReason,
    });

    logger.info("Extension request review decision", {
      invoice_id: invoiceId,
      request_id: requestId,
      decision: approve ? "approved" : "rejected",
      reviewer_id: reviewerId,
      decided_at: new Date().toISOString(),
    });

    return res.json({ success: true, data: result });
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.statusCode).json({
        error: { code: err.code, message: err.message },
      });
    }
    const appErr = err as { status?: number; code?: string; message?: string };
    return res.status(appErr.status ?? 500).json({
      error: {
        code: appErr.code ?? "INTERNAL_ERROR",
        message: appErr.message ?? "Internal server error",
      },
    });
  }
}
