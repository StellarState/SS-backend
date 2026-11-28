/**
 * Export job state machine and progress rules (#808).
 *
 * Kept free of I/O so the transitions can be tested exhaustively. The export
 * service owns the jobs; this module decides which moves are legal and keeps
 * progress monotonic and bounded.
 */

export type ExportJobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export const EXPORT_JOB_TERMINAL_STATES: readonly ExportJobState[] = [
  "completed",
  "failed",
  "cancelled",
];

const ALLOWED_TRANSITIONS: Record<ExportJobState, readonly ExportJobState[]> = {
  queued: ["running", "cancelled", "failed"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalExportState(state: ExportJobState): boolean {
  return EXPORT_JOB_TERMINAL_STATES.includes(state);
}

/** True when a job may move from `from` to `to`. A state never transitions to itself. */
export function canTransitionExportState(from: ExportJobState, to: ExportJobState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Clamp a progress value into the whole numbers 0..100. Non-finite input is treated as 0. */
export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.floor(value)));
}

/**
 * Next progress value for a job that is at `current`: never lower than
 * `current` and never above 100, so a late or out-of-order update cannot move
 * the bar backwards.
 */
export function advanceProgress(current: number, next: number): number {
  return Math.max(clampProgress(current), clampProgress(next));
}

/**
 * Progress for `processed` of `total` documents. Reserves the last point for
 * completion, so a job reads 100 only once it is actually completed. An empty
 * job (`total` of 0) reports 0.
 */
export function progressForDocuments(processed: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, processed / total));
  return Math.min(99, Math.floor(ratio * 100));
}

/**
 * Export retention and download-authorisation rules (#809).
 *
 * A signed URL is only a capability to *ask* for a file; it must never
 * outlive the file itself. These helpers keep that decision in one place so
 * the status endpoint, the download route and the cleanup sweep cannot
 * disagree about whether an export is still downloadable.
 */

/** Default retention window for a completed export's ZIP (24 hours). */
export const DEFAULT_EXPORT_RETENTION_MINUTES = 24 * 60;

export interface ExportDownloadMetadata {
  status: ExportJobState;
  /** Set once the stored object has been deleted; blocks downloads forever. */
  deletedAt?: number;
  /** Absolute time after which the ZIP is no longer downloadable. */
  retentionExpiresAt?: number;
  /** Absolute expiry of the signed download token, when one was issued. */
  downloadTokenExpiresAt?: number;
}

export type ExportDownloadState = "ready" | "deleted" | "expired" | "not_ready";

/** Absolute retention expiry for an export that completed at `completedAt`. */
export function exportRetentionExpiry(completedAt: number, retentionMinutes: number): number {
  const minutes =
    Number.isFinite(retentionMinutes) && retentionMinutes >= 0
      ? retentionMinutes
      : DEFAULT_EXPORT_RETENTION_MINUTES;
  return completedAt + minutes * 60 * 1000;
}

/** True once the export's retention window has elapsed. */
export function isExportRetentionExpired(
  job: Pick<ExportDownloadMetadata, "retentionExpiresAt">,
  now: number,
): boolean {
  return job.retentionExpiresAt !== undefined && job.retentionExpiresAt <= now;
}

/**
 * Decides whether the export's *metadata* still allows a download at `now`.
 * This is deliberately independent of the signed token: a valid signature
 * cannot make a deleted or expired export downloadable.
 */
export function exportDownloadState(
  job: ExportDownloadMetadata,
  now: number,
): ExportDownloadState {
  if (job.status !== "completed") return "not_ready";
  if (job.deletedAt !== undefined) return "deleted";
  if (isExportRetentionExpired(job, now)) return "expired";
  if (job.downloadTokenExpiresAt === undefined || job.downloadTokenExpiresAt <= now) {
    return "expired";
  }
  return "ready";
}

/** True when status polling should still advertise a download URL. */
export function canOfferExportDownload(job: ExportDownloadMetadata, now: number): boolean {
  return exportDownloadState(job, now) === "ready";
}

/**
 * Expiry to sign into a download URL: the shorter of the requested TTL and
 * the export's retention window. Returns `null` when neither leaves a usable
 * window, so a URL is never issued that could outlive its file.
 */
export function boundExportUrlExpiry(
  now: number,
  urlTtlMinutes: number,
  retentionExpiresAt: number,
): number | null {
  if (!Number.isFinite(urlTtlMinutes) || urlTtlMinutes <= 0) return null;
  if (!Number.isFinite(retentionExpiresAt)) return null;
  const expiry = Math.min(now + urlTtlMinutes * 60 * 1000, retentionExpiresAt);
  return expiry > now ? expiry : null;
}

/**
 * True when a completed export's stored object still needs deleting: its
 * retention has elapsed and its metadata has not been marked deleted yet.
 * A job that is already deleted never qualifies, which is what makes cleanup
 * retries idempotent.
 */
export function needsExportObjectCleanup(
  job: ExportDownloadMetadata & { zipPath?: string },
  now: number,
): boolean {
  return (
    job.status === "completed" &&
    job.deletedAt === undefined &&
    job.zipPath !== undefined &&
    isExportRetentionExpired(job, now)
  );
}
