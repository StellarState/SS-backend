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
