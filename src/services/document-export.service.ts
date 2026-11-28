import { randomUUID } from "crypto";
import { createWriteStream, existsSync, promises as fs } from "fs";
import path from "path";
import { finished } from "stream/promises";
import archiver from "archiver";
import { DataSource, In, LessThanOrEqual, Repository } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { InvoiceDocument } from "../models/InvoiceDocument.model";
import { DocumentExportJob } from "../models/DocumentExportJob.model";
import { Investment } from "../models/Investment.model";
import { User } from "../models/User.model";
import { KYCStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { logger, type AppLogger } from "../observability/logger";
import type { IPFSService } from "./ipfs.service";
import { createSignedDownloadToken, verifySignedDownloadToken } from "../lib/signed-url";
import {
  advanceProgress,
  boundExportUrlExpiry,
  canTransitionExportState,
  isExportRetentionExpired,
  needsExportObjectCleanup,
  progressForDocuments,
  type ExportJobState,
} from "./export-job-state";

export type ExportJobStatus = ExportJobState;

export interface ExportJob {
  id: string;
  invoiceId: string;
  requestedBy: string;
  status: ExportJobStatus;
  progress: number;
  totalDocuments: number;
  processedDocuments: number;
  zipPath?: string;
  downloadToken?: string;
  downloadTokenExpiresAt?: number;
  /** Absolute time after which the ZIP is no longer downloadable (#809). */
  retentionExpiresAt?: number;
  /**
   * Set once the stored object has been deleted. A job marked deleted never
   * becomes downloadable again, and cleanup retries never clear this.
   */
  deletedAt?: number;
  /** Last object-cleanup failure, kept so a retry can finish the delete. */
  cleanupError?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
  cancelledAt?: number;
}

export interface DocumentExportServiceDependencies {
  dataSource: DataSource;
  ipfsService: IPFSService;
  /** Must be the same durable mounted directory on every backend replica. */
  tempDir: string;
  signingSecret: string;
  urlTtlMinutes: number;
  retentionMs?: number;
  /** Clock override, so retention and cleanup races can be tested deterministically. */
  now?: () => number;
  logger?: AppLogger;
}

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const PROCESSING_LEASE_MS = 5 * 60 * 1000;
const LEASE_RENEWAL_INTERVAL_MS = 60 * 1000;

function sanitizeForFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function extensionFor(filename: string | null, mimeType: string | null): string {
  const existing = filename ? path.extname(filename) : "";
  if (existing) return existing;
  if (!mimeType) return "";
  const byMime: Record<string, string> = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
  };
  return byMime[mimeType] ?? "";
}

function toExportJob(job: DocumentExportJob): ExportJob {
  return {
    id: job.id,
    invoiceId: job.invoiceId,
    requestedBy: job.requesterId,
    status: job.status,
    progress: job.progress,
    totalDocuments: job.totalDocuments,
    processedDocuments: job.processedDocuments,
    ...(job.zipPath && job.status !== "cancelled" ? { zipPath: job.zipPath } : {}),
    ...(job.downloadToken ? { downloadToken: job.downloadToken } : {}),
    ...(job.downloadTokenExpiresAt
      ? { downloadTokenExpiresAt: job.downloadTokenExpiresAt.getTime() }
      : {}),
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt.getTime(),
    ...(job.completedAt ? { completedAt: job.completedAt.getTime() } : {}),
    ...(job.cancelledAt ? { cancelledAt: job.cancelledAt.getTime() } : {}),
    ...(job.expiresAt ? { retentionExpiresAt: job.expiresAt.getTime() } : {}),
    ...(job.deletedAt ? { deletedAt: job.deletedAt.getTime() } : {}),
    ...(job.cleanupError ? { cleanupError: job.cleanupError } : {}),
  };
}

/** Persistent, replica-safe invoice document export jobs. */
export class DocumentExportService {
  private readonly jobs: Repository<DocumentExportJob>;
  private readonly ownerId = randomUUID();
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly appLogger: AppLogger;

  constructor(private readonly dependencies: DocumentExportServiceDependencies) {
    this.jobs = dependencies.dataSource.getRepository(DocumentExportJob);
    this.retentionMs = dependencies.retentionMs ?? DEFAULT_RETENTION_MS;
    this.now = dependencies.now ?? Date.now;
    this.appLogger = dependencies.logger ?? logger;
  }

  async requestExport(invoiceId: string, requestingUserId: string): Promise<{ jobId: string }> {
    const invoice = await this.dependencies.dataSource
      .getRepository(Invoice)
      .findOneBy({ id: invoiceId });
    if (!invoice) throw new ServiceError("invoice_not_found", "Invoice not found", 404);
    await this.assertEligible(invoice, requestingUserId);

    const jobId = `exp_${invoiceId}_${this.now()}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const job = this.jobs.create({
      id: jobId,
      invoiceId,
      requesterId: requestingUserId,
      status: "queued",
      progress: 0,
      totalDocuments: 0,
      processedDocuments: 0,
      zipPath: this.archivePath(jobId),
      downloadToken: null,
      downloadTokenExpiresAt: null,
      error: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      expiresAt: null,
      deletedAt: null,
      cleanupError: null,
      completedAt: null,
      cancelledAt: null,
    });
    await this.jobs.save(job);
    setImmediate(() => void this.runExport(jobId, invoice.invoiceNumber));
    return { jobId };
  }

  async getJobStatus(jobId: string, requestingUserId: string): Promise<ExportJob | undefined> {
    const job = await this.jobs.findOneBy({ id: jobId, requesterId: requestingUserId });
    return job ? toExportJob(job) : undefined;
  }

  async cancelJob(jobId: string, requestingUserId: string): Promise<ExportJob> {
    const job = await this.jobs.findOneBy({ id: jobId, requesterId: requestingUserId });
    if (!job) throw new ServiceError("export_job_not_found", "Export job not found", 404);
    if (job.status === "cancelled") return toExportJob(job);
    if (!canTransitionExportState(job.status, "cancelled")) {
      throw new ServiceError("export_not_cancellable", `A ${job.status} export job cannot be cancelled`, 409);
    }

    const cancelledAt = new Date(this.now());
    const result = await this.jobs.update(
      { id: jobId, requesterId: requestingUserId, status: job.status },
      {
        status: "cancelled",
        cancelledAt,
        completedAt: cancelledAt,
        downloadToken: null,
        downloadTokenExpiresAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        expiresAt: new Date(cancelledAt.getTime() + this.retentionMs),
      },
    );
    if (!result.affected) return this.cancelJob(jobId, requestingUserId);
    await this.removeArchive(job);
    const cancelled = await this.jobs.findOneByOrFail({ id: jobId });
    return toExportJob(cancelled);
  }

  async getDownloadPath(jobId: string, token: string): Promise<string> {
    const job = await this.jobs.findOneBy({ id: jobId });
    if (!job || job.status !== "completed" || !job.zipPath) {
      throw new ServiceError("export_not_ready", "Export job is not ready for download", 404);
    }
    if (
      token !== job.downloadToken ||
      !verifySignedDownloadToken(this.dependencies.signingSecret, jobId, token)
    ) {
      throw new ServiceError("invalid_download_token", "Download link is invalid or has expired", 403);
    }
    return job.zipPath;
  }

  async cleanupExpiredJobs(now: Date = new Date()): Promise<{ jobsDeleted: number; archivesDeleted: number }> {
    const candidates = await this.jobs.find({
      where: [
        { status: "running", leaseExpiresAt: LessThanOrEqual(now) },
        { status: In(["completed", "failed", "cancelled"]), expiresAt: LessThanOrEqual(now) },
        { status: "queued", createdAt: LessThanOrEqual(new Date(now.getTime() - PROCESSING_LEASE_MS)) },
      ],
    });
    let jobsDeleted = 0;
    let archivesDeleted = 0;

    for (const candidate of candidates) {
      if (candidate.status === "running" || candidate.status === "queued") {
        const removed = await this.removeArchive(candidate);
        const result = await this.jobs.update(
          candidate.status === "running"
            ? {
                id: candidate.id,
                status: "running",
                leaseExpiresAt: LessThanOrEqual(now),
              }
            : {
                id: candidate.id,
                status: "queued",
                createdAt: LessThanOrEqual(new Date(now.getTime() - PROCESSING_LEASE_MS)),
              },
          {
            status: "failed",
            error: "Export worker lease expired before completion",
            completedAt: now,
            expiresAt: new Date(now.getTime() + this.retentionMs),
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        );
        if (result.affected && removed) archivesDeleted++;
        continue;
      }

      const removed = await this.removeArchive(candidate);
      if (removed) archivesDeleted++;
      const deleted = await this.jobs.delete({
        id: candidate.id,
        status: candidate.status,
        expiresAt: LessThanOrEqual(now),
      });
      jobsDeleted += deleted.affected ?? 0;
    }

    this.appLogger.info("document_export.cleanup.completed", {
      jobs_deleted: jobsDeleted,
      archives_deleted: archivesDeleted,
    });
    return { jobsDeleted, archivesDeleted };
  }

  startCleanupSchedule(intervalMs = 60 * 60 * 1000): { stop: () => void } {
    const timer = setInterval(() => {
      void this.cleanupExpiredJobs().catch((error: unknown) => {
        this.appLogger.error("document_export.cleanup.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);
    timer.unref();
    return { stop: () => clearInterval(timer) };
  }

  private async assertEligible(invoice: Invoice, requestingUserId: string): Promise<void> {
    const user = await this.dependencies.dataSource
      .getRepository(User)
      .findOneBy({ id: requestingUserId });
    if (!user) throw new ServiceError("user_not_found", "User not found", 404);
    if (user.kycStatus !== KYCStatus.APPROVED) {
      throw new ServiceError("kyc_not_approved", "KYC approval required to export documents", 403);
    }
    if (invoice.sellerId === requestingUserId) return;
    const hasInvested = await this.dependencies.dataSource.getRepository(Investment).exists({
      where: { invoiceId: invoice.id, investorId: requestingUserId },
    });
    if (!hasInvested) {
      throw new ServiceError("export_forbidden", "Only the issuer or an investor in this invoice may export its documents", 403);
    }
  }

  private archivePath(jobId: string): string {
    return path.join(path.resolve(this.dependencies.tempDir), `${jobId}.zip`);
  }

  private async removeArchive(job: DocumentExportJob): Promise<boolean> {
    if (!job.zipPath) return false;
    const resolved = path.resolve(job.zipPath);
    const root = path.resolve(this.dependencies.tempDir);
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Export archive path is outside the configured shared directory: ${resolved}`);
    }
    try {
      await fs.rm(resolved, { force: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      this.appLogger.error("document_export.archive_cleanup.failed", {
        job_id: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async runExport(jobId: string, invoiceNumber: string): Promise<void> {
    const claimed = await this.jobs.update(
      { id: jobId, status: "queued" },
      {
        status: "running",
        leaseOwner: this.ownerId,
        leaseExpiresAt: new Date(Date.now() + PROCESSING_LEASE_MS),
      },
    );
    if (!claimed.affected) return;

    const job = await this.jobs.findOneBy({ id: jobId });
    if (!job) return;
    const heartbeat = setInterval(() => {
      void this.jobs.update(
        { id: jobId, status: "running", leaseOwner: this.ownerId },
        { leaseExpiresAt: new Date(Date.now() + PROCESSING_LEASE_MS) },
      ).catch((error: unknown) => this.appLogger.error("document_export.lease_renewal.failed", {
        job_id: jobId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }, LEASE_RENEWAL_INTERVAL_MS);
    heartbeat.unref();

    try {
      const documents = await this.dependencies.dataSource
        .getRepository(InvoiceDocument)
        .find({ where: { invoiceId: job.invoiceId }, order: { createdAt: "ASC" } });
      if (documents.length === 0) throw new ServiceError("no_documents", "This invoice has no documents to export", 404);
      await this.jobs.update(
        { id: jobId, status: "running", leaseOwner: this.ownerId },
        { totalDocuments: documents.length },
      );
      await fs.mkdir(this.dependencies.tempDir, { recursive: true });
      await this.writeZip(job, invoiceNumber, documents);

      const stillRunning = await this.jobs.findOneBy({
        id: jobId,
        status: "running",
        leaseOwner: this.ownerId,
      });
      if (!stillRunning) {
        await this.removeArchive(job);
        return;
      }

      const completedAt = new Date();
      const retentionExpiresAt = completedAt.getTime() + this.retentionMs;
      // A signed URL must never outlive the archive it points at (#809).
      const urlExpiresAt = boundExportUrlExpiry(
        completedAt.getTime(),
        this.dependencies.urlTtlMinutes,
        retentionExpiresAt,
      );
      const signedDownload = urlExpiresAt === null
        ? null
        : createSignedDownloadToken(
            this.dependencies.signingSecret,
            jobId,
            (urlExpiresAt - completedAt.getTime()) / (60 * 1000),
            completedAt,
          );
      await this.jobs.update(
        { id: jobId, status: "running", leaseOwner: this.ownerId },
        {
          status: "completed",
          progress: 100,
          downloadToken: signedDownload?.token ?? null,
          downloadTokenExpiresAt: signedDownload ? new Date(signedDownload.expiresAt) : null,
          completedAt,
          expiresAt: new Date(retentionExpiresAt),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await this.removeArchive(job);
      await this.jobs.update(
        { id: jobId, status: "running", leaseOwner: this.ownerId },
        {
          status: "failed",
          error: message,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + this.retentionMs),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      );
      this.appLogger.error("document_export.job.failed", { job_id: jobId, error: message });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async writeZip(
    job: DocumentExportJob,
    invoiceNumber: string,
    documents: InvoiceDocument[],
  ): Promise<void> {
    const output = createWriteStream(job.zipPath!);
    const archive = archiver("zip", { zlib: { level: 9 } });
    const archiveLabel = sanitizeForFilename(invoiceNumber || job.invoiceId);
    const seenNames = new Map<string, number>();
    archive.on("error", (error) => output.destroy(error));
    output.on("error", () => archive.abort());
    archive.pipe(output);
    const outputFinished = finished(output);
    void outputFinished.catch(() => undefined);

    try {
      for (let index = 0; index < documents.length; index++) {
        const current = await this.jobs.findOneBy({
          id: job.id,
          status: "running",
          leaseOwner: this.ownerId,
        });
        if (!current) throw new Error("Export job was cancelled or its lease was lost");
        const fileBuffer = await this.dependencies.ipfsService.fetchFile(documents[index].cid);
        const stillRunning = await this.jobs.findOneBy({
          id: job.id,
          status: "running",
          leaseOwner: this.ownerId,
        });
        if (!stillRunning) throw new Error("Export job was cancelled or its lease was lost");

        const doc = documents[index];
        const dateStamp = doc.createdAt.toISOString().slice(0, 10);
        const docType = sanitizeForFilename(doc.docType);
        const extension = extensionFor(doc.filename, doc.mimeType);
        const baseName = `${archiveLabel}_${docType}_${dateStamp}${extension}`;
        const count = seenNames.get(baseName) ?? 0;
        seenNames.set(baseName, count + 1);
        const entryName = count === 0
          ? baseName
          : `${archiveLabel}_${docType}_${dateStamp}_${count + 1}${extension}`;
        archive.append(fileBuffer, { name: entryName });

        const processedDocuments = index + 1;
        await this.jobs.update(
          { id: job.id, status: "running", leaseOwner: this.ownerId },
          {
            processedDocuments,
            progress: advanceProgress(
              current.progress,
              progressForDocuments(processedDocuments, documents.length),
            ),
          },
        );
      }
      await archive.finalize();
      await outputFinished;
    } catch (error) {
      archive.abort();
      const closed = output.closed
        ? Promise.resolve()
        : new Promise<void>((resolve) => output.once("close", resolve));
      output.destroy();
      await closed;
      throw error;
    }
  }
}

export function createDocumentExportService(
  dependencies: DocumentExportServiceDependencies,
): DocumentExportService {
  return new DocumentExportService(dependencies);
}
