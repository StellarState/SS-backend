import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type KycWebhookEventStatus = "received" | "processing" | "succeeded" | "failed";
export type KycWebhookFailureKind = "permanent" | "retryable";

@Entity("kyc_webhook_events")
@Index("uq_kyc_webhook_events_provider_event", ["provider", "eventId"], { unique: true })
@Index("idx_kyc_webhook_events_status_processing", ["status", "processingStartedAt"])
export class KycWebhookEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 100 })
  provider!: string;

  @Column({ name: "event_id", type: "varchar", length: 255 })
  eventId!: string;

  @Column({ type: "varchar", length: 20 })
  status!: KycWebhookEventStatus;

  @Column({ type: "jsonb" })
  payload!: unknown;

  @Column({ name: "attempt_count", type: "integer", default: 0 })
  attemptCount!: number;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage!: string | null;

  @Column({ name: "failure_kind", type: "varchar", length: 20, nullable: true })
  failureKind!: KycWebhookFailureKind | null;

  @Column({ name: "received_at", type: "timestamptz", default: () => "now()" })
  receivedAt!: Date;

  @Column({ name: "processing_started_at", type: "timestamptz", nullable: true })
  processingStartedAt!: Date | null;

  @Column({ name: "completed_at", type: "timestamptz", nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
