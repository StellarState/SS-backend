import type { DeadLetter, InvoiceLifecycleEvent } from "./notification-dispatcher";

/**
 * Durable boundary for lifecycle notification delivery (issue #772).
 *
 * The dispatcher used to keep its queue, retry timers and dead letters in
 * process memory. A restart after `enqueue()` returned therefore lost the
 * event before it was ever stored, which the notification-row dedupe index
 * cannot recover. Jobs now live behind this store:
 *
 * - `create` persists a stable job before enqueue is acknowledged.
 * - `claimDue` atomically hands a due job to exactly one worker, recording
 *   ownership, the attempt count and the next-attempt time.
 * - `complete`, `reschedule` and `markDead` only accept the owning worker, so
 *   a replaced process cannot overwrite a successor's progress.
 * - failed attempts and their scheduled retry time are persisted; terminal
 *   failures stay inspectable and can be replayed under the original event id.
 *
 * Recipient-level dedupe remains in the notification store's unique
 * `dedupe_key`, so a partially delivered job can be retried without notifying
 * a recipient twice.
 */
export type NotificationJobStatus = "pending" | "processing" | "dead" | "discarded";

export interface NotificationJob {
  /** Stable identity, derived from the lifecycle event. */
  eventId: string;
  /** Correlation ID propagated from the originating request/event for tracing. */
  correlationId?: string;
  event: InvoiceLifecycleEvent;
  status: NotificationJobStatus;
  /** Attempts started so far, persisted across worker replacement. */
  attempts: number;
  /** Earliest moment the job may be claimed again. */
  nextAttemptAt: Date;
  /** Worker currently delivering the job, or null. */
  claimedBy: string | null;
  /** When the current claim was taken, used for lease recovery. */
  claimedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewNotificationJob {
  eventId: string;
  event: InvoiceLifecycleEvent;
  nextAttemptAt: Date;
  /** Optional correlation ID propagated from the originating request. */
  correlationId?: string;
}

export interface ClaimDueOptions {
  workerId: string;
  now: Date;
  limit: number;
  /** A processing claim older than this is considered abandoned. */
  leaseMs: number;
}

export interface RecoverLeasesOptions {
  now: Date;
  leaseMs: number;
}

export interface NotificationJobStore {
  /** Persists a stable job. Returns false when the identity already exists. */
  create(job: NewNotificationJob): Promise<boolean>;
  /** Atomically claims due pending jobs and abandoned claims for one worker. */
  claimDue(options: ClaimDueOptions): Promise<NotificationJob[]>;
  /** Deletes a delivered job owned by `workerId`. */
  complete(eventId: string, workerId: string): Promise<boolean>;
  /** Persists a retry: attempt count, error and next-attempt time. */
  reschedule(
    eventId: string,
    workerId: string,
    attempts: number,
    nextAttemptAt: Date,
    error: string
  ): Promise<boolean>;
  /** Persists a terminal failure, retaining the job for inspection/replay. */
  markDead(
    eventId: string,
    workerId: string,
    attempts: number,
    error: string,
    failedAt: Date
  ): Promise<boolean>;
  /** Releases claims abandoned by a stopped worker back to pending. */
  recoverExpiredLeases(options: RecoverLeasesOptions): Promise<number>;
  /** When the next pending job (or lease expiry) is due, if any. */
  nextRunAt(leaseMs: number): Promise<Date | null>;
  /** Inspects retained terminal failures, most recent first. */
  listDeadLetters(limit?: number): Promise<DeadLetter[]>;
  /** Returns a dead letter to pending under its original event id. */
  replayDeadLetter(eventId: string, actorId: string, now: Date): Promise<boolean>;
  /** Marks a dead letter discarded and records the administrator who did so. */
  discardDeadLetter(eventId: string, actorId: string, now: Date): Promise<boolean>;
  /** Deletes retained dead letters last updated before the cutoff. */
  pruneDeadLetters(olderThan: Date): Promise<number>;
  /** Pending + processing jobs, used for drain and health reporting. */
  countActive(): Promise<number>;
}

/** Deep-enough copy so callers cannot mutate persisted job state. */
function cloneJob(job: NotificationJob): NotificationJob {
  return {
    ...job,
    correlationId: job.correlationId,
    event: {
      ...job.event,
      invoice: { ...job.event.invoice },
      newDeadline: job.event.newDeadline ? new Date(job.event.newDeadline) : undefined,
    },
    nextAttemptAt: new Date(job.nextAttemptAt),
    claimedAt: job.claimedAt ? new Date(job.claimedAt) : null,
    createdAt: new Date(job.createdAt),
    updatedAt: new Date(job.updatedAt),
  };
}

/** Revives `newDeadline` after JSON round-trips through a database column. */
export function reviveLifecycleEvent(event: InvoiceLifecycleEvent): InvoiceLifecycleEvent {
  const newDeadline = event.newDeadline
    ? event.newDeadline instanceof Date
      ? event.newDeadline
      : new Date(event.newDeadline as unknown as string)
    : undefined;
  return {
    ...event,
    newDeadline:
      newDeadline && !Number.isNaN(newDeadline.getTime()) ? newDeadline : undefined,
  };
}

/**
 * Process-local implementation of {@link NotificationJobStore}. It keeps the
 * same claim/ownership/attempt semantics as the durable store so tests can
 * exercise restart boundaries, and serves as the default when no persistent
 * store is configured.
 */
export class InMemoryNotificationJobStore implements NotificationJobStore {
  private readonly jobs = new Map<string, NotificationJob>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async create(job: NewNotificationJob): Promise<boolean> {
    if (this.jobs.has(job.eventId)) return false;
    const now = this.now();
    this.jobs.set(
      job.eventId,
      cloneJob({
        eventId: job.eventId,
        correlationId: job.correlationId,
        event: job.event,
        status: "pending",
        attempts: 0,
        nextAttemptAt: job.nextAttemptAt,
        claimedBy: null,
        claimedAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      })
    );
    return true;
  }

  async claimDue({
    workerId,
    now,
    limit,
    leaseMs,
  }: ClaimDueOptions): Promise<NotificationJob[]> {
    const leaseCutoff = now.getTime() - leaseMs;
    const due = [...this.jobs.values()]
      .filter(
        (job) =>
          (job.status === "pending" && job.nextAttemptAt.getTime() <= now.getTime()) ||
          (job.status === "processing" &&
            job.claimedAt !== null &&
            job.claimedAt.getTime() <= leaseCutoff)
      )
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit);

    for (const job of due) {
      job.status = "processing";
      job.attempts += 1;
      job.claimedBy = workerId;
      job.claimedAt = new Date(now);
      job.updatedAt = new Date(now);
    }
    return due.map(cloneJob);
  }

  async complete(eventId: string, workerId: string): Promise<boolean> {
    const job = this.jobs.get(eventId);
    if (!job || job.status !== "processing" || job.claimedBy !== workerId) return false;
    this.jobs.delete(eventId);
    return true;
  }

  async reschedule(
    eventId: string,
    workerId: string,
    attempts: number,
    nextAttemptAt: Date,
    error: string
  ): Promise<boolean> {
    const job = this.jobs.get(eventId);
    if (!job || job.status !== "processing" || job.claimedBy !== workerId) return false;
    job.status = "pending";
    job.attempts = attempts;
    job.nextAttemptAt = new Date(nextAttemptAt);
    job.lastError = error;
    job.claimedBy = null;
    job.claimedAt = null;
    job.updatedAt = this.now();
    return true;
  }

  async markDead(
    eventId: string,
    workerId: string,
    attempts: number,
    error: string,
    failedAt: Date
  ): Promise<boolean> {
    const job = this.jobs.get(eventId);
    if (!job || job.status !== "processing" || job.claimedBy !== workerId) return false;
    job.status = "dead";
    job.attempts = attempts;
    job.lastError = error;
    job.claimedBy = null;
    job.claimedAt = null;
    job.updatedAt = new Date(failedAt);
    return true;
  }

  async recoverExpiredLeases({ now, leaseMs }: RecoverLeasesOptions): Promise<number> {
    const leaseCutoff = now.getTime() - leaseMs;
    let recovered = 0;
    for (const job of this.jobs.values()) {
      if (
        job.status === "processing" &&
        job.claimedAt !== null &&
        job.claimedAt.getTime() <= leaseCutoff
      ) {
        job.status = "pending";
        job.claimedBy = null;
        job.claimedAt = null;
        job.updatedAt = new Date(now);
        recovered += 1;
      }
    }
    return recovered;
  }

  async nextRunAt(leaseMs: number): Promise<Date | null> {
    let earliest: number | null = null;
    for (const job of this.jobs.values()) {
      const at =
        job.status === "pending"
          ? job.nextAttemptAt.getTime()
          : job.claimedAt
            ? job.claimedAt.getTime() + leaseMs
            : null;
      if (at !== null && (earliest === null || at < earliest)) earliest = at;
    }
    return earliest === null ? null : new Date(earliest);
  }

  async listDeadLetters(limit = 100): Promise<DeadLetter[]> {
    return [...this.jobs.values()]
      .filter((job) => job.status === "dead")
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit)
      .map((job) => ({
        eventId: job.eventId,
        event: cloneJob(job).event,
        attempts: job.attempts,
        error: job.lastError ?? "unknown error",
        failedAt: new Date(job.updatedAt),
      }));
  }

  async replayDeadLetter(eventId: string, actorId: string, now: Date): Promise<boolean> {
    void actorId;
    const job = this.jobs.get(eventId);
    if (!job || job.status !== "dead") return false;
    job.status = "pending";
    job.attempts = 0;
    job.nextAttemptAt = new Date(now);
    job.claimedBy = null;
    job.claimedAt = null;
    job.lastError = null;
    job.updatedAt = new Date(now);
    return true;
  }

  async discardDeadLetter(eventId: string, actorId: string, now: Date): Promise<boolean> {
    void actorId;
    const job = this.jobs.get(eventId);
    if (!job || job.status !== "dead") return false;
    job.status = "discarded";
    job.updatedAt = new Date(now);
    return true;
  }

  async pruneDeadLetters(olderThan: Date): Promise<number> {
    let removed = 0;
    for (const [eventId, job] of this.jobs) {
      if (job.status === "dead" && job.updatedAt.getTime() < olderThan.getTime()) {
        this.jobs.delete(eventId);
        removed += 1;
      }
    }
    return removed;
  }

  async countActive(): Promise<number> {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "pending" || job.status === "processing") count += 1;
    }
    return count;
  }

  /** Test/observability helper: inspect a job without claiming it. */
  peek(eventId: string): NotificationJob | null {
    const job = this.jobs.get(eventId);
    return job ? cloneJob(job) : null;
  }
}
