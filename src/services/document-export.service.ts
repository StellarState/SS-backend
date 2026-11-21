import { DataSource } from "typeorm";
import { createWriteStream, existsSync, promises as fs } from "fs";
import path from "path";
import archiver from "archiver";
import { Invoice } from "../models/Invoice.model";
import { InvoiceDocument } from "../models/InvoiceDocument.model";
import { Investment } from "../models/Investment.model";
import { User } from "../models/User.model";
import { KYCStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import type { IPFSService } from "./ipfs.service";
import { createSignedDownloadToken, verifySignedDownloadToken } from "../lib/signed-url";
import {
  advanceProgress,
  boundExportUrlExpiry,
  canTransitionExportState,
  DEFAULT_EXPORT_RETENTION_MINUTES,
  exportRetentionExpiry,
  isExportRetentionExpired,
  isTerminalExportState,
  needsExportObjectCleanup,
  progressForDocuments,
  type ExportJobState,
} from "./export-job-state";

export type ExportJobStatus = ExportJobState;

export interface ExportJob {
  id: string;
  invoiceId: string;
  /** User who requested the export; the only user who may inspect or cancel it. */
  requestedBy: string;
  status: ExportJobStatus;
  /** 0-100, never decreases, 100 only once the job is completed. */
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
  tempDir: string;
  signingSecret: string;
  urlTtlMinutes: number;
  /**
   * How long a completed export stays downloadable (and its ZIP retained).
   * Defaults to 24 hours. Signed URLs are never issued past this window.
   */
  retentionMinutes?: number;
  /** Clock override, so retention/cleanup races can be tested deterministically. */
  now?: () => number;
}

/** Characters outside `[A-Za-z0-9._-]` are not safe in a ZIP entry/file name across platforms. */
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

/**
 * Bulk document export (issue #589): fetches every document pinned for an
 * invoice, packages them into a ZIP, and hands back a signed download URL.
 *
 * Generation runs as a background job (`requestExport` returns immediately
 * with a job id; `getJobStatus` polls it) because fetching N documents from
 * an IPFS gateway is network-bound and the issue's own acceptance criteria
 * calls out "Large document sets (10+ files) handled without timeout" --
 * exactly the case a synchronous request handler would be most likely to
 * blow a client or proxy timeout on.
 */
export class DocumentExportService {
  private readonly jobs = new Map<string, ExportJob>();
  private readonly now: () => number;
  private readonly retentionMinutes: number;

  constructor(private readonly dependencies: DocumentExportServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.retentionMinutes = dependencies.retentionMinutes ?? DEFAULT_EXPORT_RETENTION_MINUTES;
  }

  /** Starts generating the ZIP in the background and returns a job id immediately. */
  async requestExport(invoiceId: string, requestingUserId: string): Promise<{ jobId: string }> {
    const invoice = await this.dependencies.dataSource
      .getRepository(Invoice)
      .findOneBy({ id: invoiceId });
    if (!invoice) {
      throw new ServiceError("invoice_not_found", "Invoice not found", 404);
    }

    await this.assertEligible(invoice, requestingUserId);

    const jobId = `exp_${invoiceId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const job: ExportJob = {
      id: jobId,
      invoiceId,
      requestedBy: requestingUserId,
      status: "queued",
      progress: 0,
      totalDocuments: 0,
      processedDocuments: 0,
      createdAt: Date.now(),
    };
    this.jobs.set(jobId, job);

    // Fire-and-forget: the caller polls `getJobStatus`, it does not await this.
    // Starting on the next turn of the event loop leaves the job observably
    // `queued` (and cancellable before any work happens) when this returns.
    setImmediate(() => {
      void this.runExport(job, invoice.invoiceNumber);
    });

    return { jobId };
  }

  /**
   * Returns the job only to the user who requested it. Any other caller gets
   * `undefined`, the same answer as an unknown id, so job ids cannot be probed.
   */
  getJobStatus(jobId: string, requestingUserId: string): ExportJob | undefined {
    const job = this.jobs.get(jobId);
    if (!job || job.requestedBy !== requestingUserId) return undefined;
    return job;
  }

  /**
   * Cancels a queued or running job (#808).
   *
   * Idempotent: cancelling an already-cancelled job returns it unchanged. A job
   * that has completed or failed cannot be cancelled (409). Not-found and
   * not-yours look identical (404). The transition is checked and applied in
   * one synchronous step, so it cannot interleave with the export finishing:
   * whichever lands first wins and the other sees the new state.
   */
  cancelJob(jobId: string, requestingUserId: string): ExportJob {
    const job = this.getJobStatus(jobId, requestingUserId);
    if (!job) {
      throw new ServiceError("export_job_not_found", "Export job not found", 404);
    }
    if (job.status === "cancelled") return job;
    if (!canTransitionExportState(job.status, "cancelled")) {
      throw new ServiceError(
        "export_not_cancellable",
        `A ${job.status} export job cannot be cancelled`,
        409,
      );
    }

    job.status = "cancelled";
    job.cancelledAt = Date.now();
    job.completedAt = job.cancelledAt;
    // A cancelled job never offers a download.
    delete job.downloadToken;
    delete job.downloadTokenExpiresAt;
    if (job.zipPath) {
      void fs.rm(job.zipPath, { force: true }).catch(() => undefined);
      delete job.zipPath;
    }
    return job;
  }

  private transition(job: ExportJob, to: ExportJobStatus): boolean {
    if (!canTransitionExportState(job.status, to)) return false;
    job.status = to;
    return true;
  }

  private setProgress(job: ExportJob, value: number): void {
    if (isTerminalExportState(job.status)) return;
    job.progress = advanceProgress(job.progress, value);
  }

  /**
   * Streams the ZIP for a completed job, after verifying `token` against
   * the signed URL issued when the job completed. Returns the file path on
   * success; throws on an unknown job, a job that is not done, or an
   * invalid/expired token.
   *
   * The export's metadata is revalidated on every download (#809): a token's
   * signature is not authority to read a file that has since been deleted or
   * whose retention window has elapsed. Only after both checks pass is the
   * object inspected, which also catches a storage backend that removed the
   * ZIP before the metadata was updated.
   */
  getDownloadPath(jobId: string, token: string): string {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new ServiceError("export_not_ready", "Export job is not ready for download", 404);
    }

    const now = this.now();
    if (job.deletedAt !== undefined) {
      throw new ServiceError("export_deleted", "This export has been deleted", 410);
    }
    if (isExportRetentionExpired(job, now)) {
      throw new ServiceError("export_expired", "This export has expired", 410);
    }
    if (job.status !== "completed" || !job.zipPath) {
      throw new ServiceError("export_not_ready", "Export job is not ready for download", 404);
    }

    // Verify against the same clock used for the retention check, so the
    // token cannot outlive the metadata decision above.
    const valid = verifySignedDownloadToken(
      this.dependencies.signingSecret,
      jobId,
      token,
      new Date(now),
    );
    if (!valid) {
      throw new ServiceError("invalid_download_token", "Download link is invalid or has expired", 403);
    }

    if (!existsSync(job.zipPath)) {
      throw new ServiceError("export_file_missing", "Export file is no longer available", 410);
    }

    return job.zipPath;
  }

  /**
   * Coordinates object cleanup with the export's metadata (#809).
   *
   * Removes the stored ZIP once retention has elapsed, then marks the job
   * deleted and drops its download token. Only a completed, not-yet-deleted
   * job whose retention has passed does any work, so retrying cleanup after a
   * successful delete is a no-op: it cannot resurrect the token, the ZIP path
   * or an older status. A failed delete leaves the metadata untouched so a
   * later retry can finish the job; downloads stay blocked by the retention
   * check in the meantime.
   */
  async cleanupExport(jobId: string, now: number = this.now()): Promise<ExportJob | undefined> {
    const job = this.jobs.get(jobId);
    if (!job || !job.zipPath || !needsExportObjectCleanup(job, now)) return job;

    try {
      await fs.rm(job.zipPath, { force: true });
    } catch (error) {
      job.cleanupError = error instanceof Error ? error.message : "Unknown cleanup error";
      return job;
    }

    // A concurrent cleanup may have finished while this delete was in flight;
    // never re-apply the metadata transition over an already-deleted job.
    if (job.deletedAt !== undefined) return job;

    job.deletedAt = now;
    delete job.zipPath;
    delete job.downloadToken;
    delete job.downloadTokenExpiresAt;
    delete job.cleanupError;
    return job;
  }

  /**
   * Deletes every exported object whose retention window has elapsed.
   * Returns the ids that were cleaned; jobs whose delete failed stay around
   * (with `cleanupError`) for the next sweep.
   */
  async cleanupExpiredExports(now: number = this.now()): Promise<string[]> {
    const expired = [...this.jobs.values()].filter((job) => needsExportObjectCleanup(job, now));
    const cleaned: string[] = [];
    for (const job of expired) {
      const updated = await this.cleanupExport(job.id, now);
      if (updated?.deletedAt !== undefined) cleaned.push(job.id);
    }
    return cleaned;
  }

  private async assertEligible(invoice: Invoice, requestingUserId: string): Promise<void> {
    const user = await this.dependencies.dataSource
      .getRepository(User)
      .findOneBy({ id: requestingUserId });
    if (!user) {
      throw new ServiceError("user_not_found", "User not found", 404);
    }
    if (user.kycStatus !== KYCStatus.APPROVED) {
      throw new ServiceError("kyc_not_approved", "KYC approval required to export documents", 403);
    }

    const isIssuer = invoice.sellerId === requestingUserId;
    if (isIssuer) return;

    const hasInvested = await this.dependencies.dataSource.getRepository(Investment).exists({
      where: { invoiceId: invoice.id, investorId: requestingUserId },
    });
    if (!hasInvested) {
      throw new ServiceError(
        "export_forbidden",
        "Only the issuer or an investor in this invoice may export its documents",
        403,
      );
    }
  }

  private async runExport(job: ExportJob, invoiceNumber: string): Promise<void> {
    // The job may have been cancelled between being queued and starting.
    if (!this.transition(job, "running")) return;

    try {
      const documents = await this.dependencies.dataSource
        .getRepository(InvoiceDocument)
        .find({ where: { invoiceId: job.invoiceId }, order: { createdAt: "ASC" } });
      if (job.status !== "running") return;

      if (documents.length === 0) {
        throw new ServiceError("no_documents", "This invoice has no documents to export", 404);
      }
      job.totalDocuments = documents.length;

      await fs.mkdir(this.dependencies.tempDir, { recursive: true });
      const zipPath = path.join(this.dependencies.tempDir, `${job.id}.zip`);

      await this.writeZip(zipPath, job, invoiceNumber, documents);

      // Cancelled while the archive was being written: discard the file and
      // leave the job cancelled instead of overwriting that with "completed".
      if (job.status !== "running") {
        await fs.rm(zipPath, { force: true }).catch(() => undefined);
        return;
      }

      const completedAt = this.now();
      const retentionExpiresAt = exportRetentionExpiry(completedAt, this.retentionMinutes);
      // The URL TTL may not exceed the retention window: a signed link must
      // never be usable after its file has been deleted (#809).
      const urlExpiresAt = boundExportUrlExpiry(
        completedAt,
        this.dependencies.urlTtlMinutes,
        retentionExpiresAt,
      );

      if (!this.transition(job, "completed")) return;
      job.progress = 100;
      job.zipPath = zipPath;
      job.completedAt = completedAt;
      job.retentionExpiresAt = retentionExpiresAt;

      if (urlExpiresAt !== null) {
        const { token, expiresAt } = createSignedDownloadToken(
          this.dependencies.signingSecret,
          job.id,
          (urlExpiresAt - completedAt) / (60 * 1000),
          new Date(completedAt),
        );
        job.downloadToken = token;
        job.downloadTokenExpiresAt = expiresAt;
      }
    } catch (error) {
      if (!this.transition(job, "failed")) return;
      job.error = error instanceof Error ? error.message : "Unknown error";
      job.completedAt = Date.now();
    }
  }

  private async writeZip(
    zipPath: string,
    job: ExportJob,
    invoiceNumber: string,
    documents: InvoiceDocument[],
  ): Promise<void> {
    const invoiceId = job.invoiceId;
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    const done = new Promise<void>((resolve, reject) => {
      output.on("close", resolve);
      archive.on("error", reject);
    });
    archive.pipe(output);

    const invoiceLabel = sanitizeForFilename(invoiceNumber || invoiceId);
    const seenNames = new Map<string, number>();

    for (const doc of documents) {
      // Stop fetching as soon as the job is cancelled.
      if (job.status !== "running") break;

      const fileBuffer = await this.dependencies.ipfsService.fetchFile(doc.cid);

      const dateStamp = doc.createdAt.toISOString().slice(0, 10);
      const docType = sanitizeForFilename(doc.docType);
      const extension = extensionFor(doc.filename, doc.mimeType);
      let entryName = `${invoiceLabel}_${docType}_${dateStamp}${extension}`;

      // Structured naming can collide when an invoice has two documents of
      // the same type uploaded the same day; disambiguate rather than let
      // archiver silently overwrite one entry with the other.
      const count = seenNames.get(entryName) ?? 0;
      seenNames.set(entryName, count + 1);
      if (count > 0) {
        entryName = `${invoiceLabel}_${docType}_${dateStamp}_${count + 1}${extension}`;
      }

      archive.append(fileBuffer, { name: entryName });

      job.processedDocuments += 1;
      this.setProgress(job, progressForDocuments(job.processedDocuments, documents.length));
    }

    await archive.finalize();
    await done;
  }
}

export function createDocumentExportService(
  dependencies: DocumentExportServiceDependencies,
): DocumentExportService {
  return new DocumentExportService(dependencies);
}
