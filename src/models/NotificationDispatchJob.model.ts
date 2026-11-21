import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";
import type { InvoiceLifecycleEvent } from "../lib/notification-dispatcher";
import type { NotificationJobStatus } from "../lib/notification-job-store";

/**
 * Durable lifecycle notification job (issue #772).
 *
 * One row per lifecycle event. The row is written before `enqueue()` is
 * acknowledged, claimed atomically by one worker at a time, and deleted once
 * delivery completes. Retry state (`attempts`, `next_attempt_at`) survives a
 * restart, and terminal failures are retained with the original event payload
 * so they can be inspected and replayed.
 */
@Entity("notification_dispatch_jobs")
@Index("idx_notification_dispatch_jobs_due", ["status", "nextAttemptAt"])
@Index("idx_notification_dispatch_jobs_claim", ["status", "claimedAt"])
@Index("idx_notification_dispatch_jobs_updated", ["updatedAt"])
export class NotificationDispatchJob {
  /** Stable event identity; replay reuses it, so recipients stay deduped. */
  @PrimaryColumn({ name: "event_id", type: "varchar", length: 191 })
  eventId!: string;

  // `json` is supported by both Postgres (jsonb-compatible in the migration)
  // and the SQLite development/test driver.
  @Column({ type: "json" })
  event!: InvoiceLifecycleEvent;

  @Column({ type: "varchar", length: 16, default: "pending" })
  status!: NotificationJobStatus;

  @Column({ type: "integer", default: 0 })
  attempts!: number;

  @Column({ name: "next_attempt_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  nextAttemptAt!: Date;

  @Column({ name: "claimed_by", type: "varchar", length: 64, nullable: true })
  claimedBy!: string | null;

  @Column({ name: "claimed_at", type: "timestamptz", nullable: true })
  claimedAt!: Date | null;

  @Column({ name: "last_error", type: "text", nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
