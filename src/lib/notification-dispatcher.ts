import { randomUUID } from "crypto";
import { logger as defaultLogger, type AppLogger } from "../observability/logger";
import { getCorrelationId } from "../observability/request-context";
import { InvoiceStatus, NotificationType } from "../types/enums";
import type { Invoice } from "../models/Invoice.model";
import type { InvestorDirectory } from "./invoice-notifications";
import type { InvoiceTransition, TransitionEffect } from "./invoice-state-machine";
import {
  InMemoryNotificationJobStore,
  type NotificationJob,
  type NotificationJobStore,
} from "./notification-job-store";

/**
 * Queue-based batch notification dispatcher for invoice lifecycle events.
 *
 * Callers enqueue an event and return once it is durably persisted; recipients
 * are resolved and notifications written in the background, so fan-out to many
 * investors never blocks the request that caused the event. Every notification
 * carries a dedupe key of `<eventId>:<userId>`, which the store enforces as
 * unique, so a re-dispatched event, a recovered job, or a retried partial
 * delivery cannot notify a wallet twice.
 *
 * Jobs live in a {@link NotificationJobStore}. Each delivery attempt claims the
 * job for one worker, persists the attempt count and next-attempt time, and
 * only the owning worker may complete or reschedule it. A job that keeps
 * failing is retried up to {@link DEFAULT_MAX_ATTEMPTS} times in total and then
 * dead-lettered with its original identity, where it stays inspectable and can
 * be replayed deliberately.
 */

export type InvoiceLifecycleEventKind =
  | "funded"
  | "settled"
  | "rejected"
  | "approved"
  | "deadline_extended"
  | "matured";

export type InvoiceEventSubject = Pick<Invoice, "id" | "sellerId" | "invoiceNumber">;

export interface InvoiceLifecycleEvent {
  kind: InvoiceLifecycleEventKind;
  /** Optional correlation ID propagated from the originating request. */
  correlationId?: string;
  invoice: InvoiceEventSubject;
  /** Rejection reason, or other free text shown in the message. */
  reason?: string | null;
  /** New deadline, for `deadline_extended`. */
  newDeadline?: Date;
  /**
   * Identifies the event for deduplication. Defaults to one id per
   * (kind, invoice), plus the new deadline for extensions, since those can
   * legitimately happen more than once.
   */
  eventId?: string;
}

export interface DedupedNotification {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  dedupeKey: string;
}

/** Writes notifications, skipping any whose dedupe key already exists. */
export interface DedupedNotificationStore {
  insertIgnoringDuplicates(entries: DedupedNotification[]): Promise<void>;
}

export interface DeadLetter {
  eventId: string;
  event: InvoiceLifecycleEvent;
  attempts: number;
  error: string;
  failedAt: Date;
}

export interface DeadLetterSink {
  record(entry: DeadLetter): void | Promise<void>;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_DEAD_LETTER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type Audience = "seller" | "investors";

interface EventTemplate {
  type: NotificationType;
  audience: readonly Audience[];
  title: string;
  message: (event: InvoiceLifecycleEvent) => string;
}

const TEMPLATES: Record<InvoiceLifecycleEventKind, EventTemplate> = {
  funded: {
    type: NotificationType.INVOICE_FUNDED,
    audience: ["seller", "investors"],
    title: "Invoice Funded",
    message: ({ invoice }) => `Invoice ${invoice.invoiceNumber} has been fully funded.`,
  },
  settled: {
    type: NotificationType.INVOICE_SETTLED,
    audience: ["seller", "investors"],
    title: "Invoice Settled",
    message: ({ invoice }) =>
      `Invoice ${invoice.invoiceNumber} has settled and returns have been distributed.`,
  },
  rejected: {
    type: NotificationType.INVOICE_REJECTED,
    audience: ["seller"],
    title: "Invoice Rejected",
    message: ({ invoice, reason }) =>
      `Your invoice ${invoice.invoiceNumber} has been rejected: ${reason ?? "no reason given"}`,
  },
  approved: {
    type: NotificationType.INVOICE_APPROVED,
    audience: ["seller"],
    title: "Invoice Approved",
    message: ({ invoice }) =>
      `Your invoice ${invoice.invoiceNumber} has been approved and is now live on the marketplace.`,
  },
  deadline_extended: {
    type: NotificationType.INVOICE_DEADLINE_EXTENDED,
    audience: ["seller", "investors"],
    title: "Invoice Deadline Extended",
    message: ({ invoice, newDeadline }) =>
      `The deadline for invoice ${invoice.invoiceNumber} has been extended` +
      (newDeadline ? ` to ${newDeadline.toISOString().slice(0, 10)}.` : "."),
  },
  matured: {
    type: NotificationType.INVOICE_MATURED,
    audience: ["seller", "investors"],
    title: "Invoice Matured",
    message: ({ invoice }) => `Invoice ${invoice.invoiceNumber} has reached its maturity date.`,
  },
};

export function eventIdFor(event: InvoiceLifecycleEvent): string {
  if (event.eventId) return event.eventId;
  const base = `invoice:${event.invoice.id}:${event.kind}`;
  return event.kind === "deadline_extended" && event.newDeadline
    ? `${base}:${event.newDeadline.toISOString()}`
    : base;
}

/** Maps a committed status transition onto the lifecycle event it represents, if any. */
export function lifecycleEventForTransition(
  transition: InvoiceTransition
): InvoiceLifecycleEvent | null {
  const kind = ((): InvoiceLifecycleEventKind | null => {
    switch (transition.to) {
      case InvoiceStatus.FUNDED:
        return "funded";
      case InvoiceStatus.SETTLED:
        return "settled";
      case InvoiceStatus.REJECTED:
        return "rejected";
      case InvoiceStatus.PUBLISHED:
        return transition.trigger === "admin_approved" ? "approved" : null;
      default:
        return null;
    }
  })();

  return kind ? { kind, invoice: transition.invoice, reason: transition.reason } : null;
}

export interface NotificationDispatcherOptions {
  store: DedupedNotificationStore;
  investors: InvestorDirectory;
  deadLetters?: DeadLetterSink;
  logger?: AppLogger;
  maxAttempts?: number;
  /** Delay before retry n is `retryDelayMs * 2^(n-1)`. */
  retryDelayMs?: number;
  concurrency?: number;
  /** Test hook for scheduling; defaults to setTimeout. */
  schedule?: (work: () => void, delayMs: number) => void;
  /** Durable job boundary. Defaults to an in-memory store. */
  jobs?: NotificationJobStore;
  /** Stable identity of this worker for claim ownership. */
  workerId?: string;
  /** A claim older than this is assumed abandoned and may be reclaimed. */
  leaseMs?: number;
  /** How long terminal failures stay inspectable before pruning. */
  deadLetterRetentionMs?: number;
  /** Injectable clock for deterministic retry scheduling. */
  now?: () => Date;
  /**
   * When false, `enqueue` only persists and never starts delivery on its own;
   * callers drive work through `recover()`/`drain()`. Used by restart tests and
   * by deployments that run dispatch in a separate worker.
   */
  autoDispatch?: boolean;
}

export class NotificationDispatcher {
  private active = 0;
  private pumping = false;
  private pumpPromise: Promise<void> | null = null;
  private wakeupScheduled = false;
  private readonly idleWaiters: Array<() => void> = [];

  private readonly log: AppLogger;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly concurrency: number;
  private readonly schedule: (work: () => void, delayMs: number) => void;
  private readonly jobs: NotificationJobStore;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly deadLetterRetentionMs: number;
  private readonly now: () => Date;
  private readonly autoDispatch: boolean;

  constructor(private readonly options: NotificationDispatcherOptions) {
    this.log = options.logger ?? defaultLogger;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.schedule =
      options.schedule ??
      ((work, delayMs) => {
        setTimeout(work, delayMs).unref?.();
      });
    this.now = options.now ?? (() => new Date());
    this.jobs =
      options.jobs ??
      new InMemoryNotificationJobStore({ now: this.now });
    this.workerId = options.workerId ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.deadLetterRetentionMs =
      options.deadLetterRetentionMs ?? DEFAULT_DEAD_LETTER_RETENTION_MS;
    this.autoDispatch = options.autoDispatch !== false;
  }

  /**
   * Persists an event and returns once it is durably queued. Returns false when
   * the event is already known (pending, in flight, or dead-lettered).
   */
  async enqueue(
    event: InvoiceLifecycleEvent,
    correlationId?: string
  ): Promise<boolean> {
    const resolvedCorrelationId =
      correlationId ??
      event.correlationId ??
      getCorrelationId?.() ??
      randomUUID();
    const eventWithCorrelation: InvoiceLifecycleEvent = {
      ...event,
      correlationId: resolvedCorrelationId,
    };
    const eventId = eventIdFor(event);
    const created = await this.jobs.create({
      eventId,
      event: eventWithCorrelation,
      nextAttemptAt: this.now(),
      correlationId: resolvedCorrelationId,
    });
    if (!created) return false;
    if (this.autoDispatch) setImmediate(() => void this.pump());
    return true;
  }

  /**
   * Startup recovery: reclaims abandoned claims, prunes expired dead letters,
   * and resumes every pending or retry-due job. Safe to call on a replacement
   * worker before it starts accepting new events.
   */
  async recover(): Promise<void> {
    const now = this.now();
    const recovered = await this.jobs.recoverExpiredLeases({ now, leaseMs: this.leaseMs });
    if (recovered > 0) {
      this.log.warn("Recovered abandoned notification delivery claims.", {
        worker_id: this.workerId,
        recovered,
      });
    }
    const pruned = await this.jobs.pruneDeadLetters(
      new Date(now.getTime() - this.deadLetterRetentionMs)
    );
    if (pruned > 0) {
      this.log.info("Pruned expired notification dead letters.", {
        worker_id: this.workerId,
        pruned,
      });
    }
    await this.pump();
  }

  /** Resolves once no work is pending or in flight. */
  async drain(): Promise<void> {
    for (;;) {
      await this.pump();
      if (this.active === 0 && (await this.jobs.countActive()) === 0) return;
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }

  /** Retained terminal failures, newest first. */
  async listDeadLetters(limit?: number): Promise<DeadLetter[]> {
    return this.jobs.listDeadLetters(limit);
  }

  /** Deliberately re-queues a dead letter under its original event identity. */
  async replayDeadLetter(eventId: string): Promise<boolean> {
    const replayed = await this.jobs.replayDeadLetter(eventId, this.now());
    if (replayed && this.autoDispatch) setImmediate(() => void this.pump());
    return replayed;
  }

  /**
   * Claims and delivers due jobs. At most one pump loop runs per dispatcher;
   * concurrent callers await the same loop.
   */
  private async pump(): Promise<void> {
    if (this.pumping) {
      await this.pumpPromise;
      return;
    }
    this.pumping = true;
    this.pumpPromise = this.runPumpLoop().finally(() => {
      this.pumping = false;
      this.pumpPromise = null;
    });
    try {
      await this.pumpPromise;
    } finally {
      void this.checkIdle();
    }
  }

  private async runPumpLoop(): Promise<void> {
    try {
      while (this.active < this.concurrency) {
        const limit = this.concurrency - this.active;
        const jobs = await this.jobs.claimDue({
          workerId: this.workerId,
          now: this.now(),
          limit,
          leaseMs: this.leaseMs,
        });
        if (jobs.length === 0) break;

        for (const job of jobs) {
          this.active += 1;
          void this.run(job).finally(() => {
            this.active -= 1;
            void this.pump().then(() => this.checkIdle());
          });
        }
        if (jobs.length < limit) break;
      }
    } finally {
      await this.scheduleWakeupIfIdle();
    }
  }

  /** Schedules one future pump when pending retries or leases are not yet due. */
  private async scheduleWakeupIfIdle(): Promise<void> {
    if (this.active > 0 || this.wakeupScheduled) return;
    const next = await this.jobs.nextRunAt(this.leaseMs);
    if (!next) return;
    const delayMs = Math.max(0, next.getTime() - this.now().getTime());
    this.wakeupScheduled = true;
    this.schedule(() => {
      this.wakeupScheduled = false;
      void this.pump();
    }, delayMs);
  }

  private async run(job: NotificationJob): Promise<void> {
    const { eventId, event } = job;
    const correlationId = job.correlationId ?? event.correlationId;
    try {
      const count = await this.deliver(job);
      const completed = await this.jobs.complete(eventId, this.workerId);
      this.log.info("Dispatched invoice lifecycle notifications.", {
        event_id: eventId,
        correlation_id: correlationId,
        kind: event.kind,
        invoice_id: event.invoice.id,
        recipient_count: count,
        attempt: job.attempts,
        worker_id: this.workerId,
        ownership_kept: completed,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (job.attempts < this.maxAttempts) {
        const delay = this.retryDelayMs * 2 ** (job.attempts - 1);
        const nextAttemptAt = new Date(this.now().getTime() + delay);
        const persisted = await this.jobs.reschedule(
          eventId,
          this.workerId,
          job.attempts,
          nextAttemptAt,
          message
        );
        this.log.warn("Notification dispatch failed; retry persisted.", {
          event_id: eventId,
          correlation_id: correlationId,
          attempt: job.attempts,
          max_attempts: this.maxAttempts,
          next_attempt_at: nextAttemptAt.toISOString(),
          worker_id: this.workerId,
          ownership_kept: persisted,
          error: message,
        });
        if (!persisted) {
          this.log.warn("Retry dropped: this worker no longer owns the job.", {
            event_id: eventId,
            correlation_id: correlationId,
            worker_id: this.workerId,
          });
        }
        return;
      }

      const deadLetter: DeadLetter = {
        eventId,
        event,
        attempts: job.attempts,
        error: message,
        failedAt: this.now(),
      };
      const persisted = await this.jobs.markDead(
        eventId,
        this.workerId,
        job.attempts,
        message,
        deadLetter.failedAt
      );
      this.log.error("Notification dispatch dead-lettered.", {
        event_id: eventId,
        correlation_id: correlationId,
        kind: event.kind,
        invoice_id: event.invoice.id,
        attempts: job.attempts,
        worker_id: this.workerId,
        ownership_kept: persisted,
        error: message,
      });
      if (!persisted) return;
      try {
        await this.options.deadLetters?.record(deadLetter);
      } catch (sinkError) {
        this.log.error("Failed to record notification dead letter.", {
          event_id: eventId,
          correlation_id: correlationId,
          error: sinkError instanceof Error ? sinkError.message : String(sinkError),
        });
      }
    }
  }

  private async deliver({ eventId, event }: Pick<NotificationJob, "eventId" | "event">): Promise<number> {
    const template = TEMPLATES[event.kind];
    const recipients = new Set<string>();
    if (template.audience.includes("seller")) {
      recipients.add(event.invoice.sellerId);
    }
    if (template.audience.includes("investors")) {
      for (const id of await this.options.investors.findInvestorIds(event.invoice.id)) {
        recipients.add(id);
      }
    }

    const message = template.message(event);
    await this.options.store.insertIgnoringDuplicates(
      [...recipients].map((userId) => ({
        userId,
        type: template.type,
        title: template.title,
        message,
        dedupeKey: `${eventId}:${userId}`,
      }))
    );
    return recipients.size;
  }

  private async checkIdle(): Promise<void> {
    if (this.active > 0 || this.pumping) return;
    if ((await this.jobs.countActive()) > 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}

/** In-memory dead-letter list; entries are also logged at error level by the dispatcher. */
export class InMemoryDeadLetterSink implements DeadLetterSink {
  readonly entries: DeadLetter[] = [];
  record(entry: DeadLetter): void {
    this.entries.push(entry);
  }
}

/** State machine effect: enqueue the lifecycle event for a committed transition. */
export function createNotificationDispatchEffect(
  dispatcher: Pick<NotificationDispatcher, "enqueue">
): TransitionEffect {
  return async function enqueueLifecycleNotifications(transition) {
    const event = lifecycleEventForTransition(transition);
    if (event) await dispatcher.enqueue(event);
  };
}

/** True for transitions whose notifications the dispatcher owns. */
export function isDispatchedTransition(transition: InvoiceTransition): boolean {
  return lifecycleEventForTransition(transition) !== null;
}

/** Wraps an effect so it skips transitions the dispatcher already notifies about. */
export function unlessDispatched(effect: TransitionEffect): TransitionEffect {
  return function skipDispatchedTransitions(transition) {
    return isDispatchedTransition(transition) ? undefined : effect(transition);
  };
}
