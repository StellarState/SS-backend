import { Request, Response } from "express";
import { AuthenticatedRequest } from "../types/auth";
import { DocumentExportService, type ExportJob } from "../services/document-export.service";

export class DocumentExportController {
  constructor(private readonly documentExportService: DocumentExportService) {}

  requestExport = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const invoiceId = req.params.id as string;
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
      }

      const { jobId } = await this.documentExportService.requestExport(invoiceId, user.id);

      return res.status(202).json({
        success: true,
        data: { jobId, status: "queued", progress: 0 },
      });
    } catch (err: unknown) {
      return respondWithError(res, err);
    }
  };

  getExportStatus = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
      }

      const jobId = req.params.jobId as string;
      const job = await this.documentExportService.getJobStatus(jobId, user.id);
      // A job for another invoice or another user is reported as missing.
      if (!job || job.invoiceId !== req.params.id) {
        return res.status(404).json({ error: { code: "export_job_not_found", message: "Export job not found" } });
      }

      return res.status(200).json({ success: true, data: serializeJob(job) });
    } catch (err: unknown) {
      return respondWithError(res, err);
    }
  };

  cancelExport = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
      }

      const jobId = req.params.jobId as string;
      const existing = await this.documentExportService.getJobStatus(jobId, user.id);
      if (!existing || existing.invoiceId !== req.params.id) {
        return res.status(404).json({ error: { code: "export_job_not_found", message: "Export job not found" } });
      }

      const job = await this.documentExportService.cancelJob(jobId, user.id);
      return res.status(200).json({ success: true, data: serializeJob(job) });
    } catch (err: unknown) {
      return respondWithError(res, err);
    }
  };

  downloadExport = async (req: Request, res: Response) => {
    try {
      const jobId = req.params.jobId as string;
      const token = req.query.token as string | undefined;
      if (!token) {
        return res.status(400).json({ error: { code: "missing_token", message: "token query param is required" } });
      }

      const zipPath = await this.documentExportService.getDownloadPath(jobId, token);
      return res.download(zipPath, `${jobId}.zip`);
    } catch (err: unknown) {
      return respondWithError(res, err);
    }
  };
}

function serializeJob(job: ExportJob): Record<string, unknown> {
  const data: Record<string, unknown> = {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    processedDocuments: job.processedDocuments,
    totalDocuments: job.totalDocuments,
    createdAt: new Date(job.createdAt).toISOString(),
  };
  if (job.status === "completed" && job.downloadToken) {
    data.downloadUrl = `/api/v1/invoices/${job.invoiceId}/documents/export/${job.id}/download?token=${job.downloadToken}`;
    data.expiresAt = new Date(job.downloadTokenExpiresAt!).toISOString();
  }
  if (job.status === "failed") {
    data.error = job.error;
  }
  if (job.completedAt) {
    data.finishedAt = new Date(job.completedAt).toISOString();
  }
  return data;
}

function respondWithError(res: Response, err: unknown) {
  const statusCode =
    (err as { statusCode?: number }).statusCode || (err as { status?: number }).status || 500;
  return res.status(statusCode).json({
    error: {
      code: (err as { code?: string }).code || "INTERNAL_ERROR",
      message: (err as { message?: string }).message || "Internal server error",
    },
  });
}
