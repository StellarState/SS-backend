import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export enum NotificationDeadLetterStatus {
  PENDING = "pending",
  RETRYING = "retrying",
  DELIVERED = "delivered",
  DEAD = "dead",
  DISCARDED = "discarded",
}

@Entity("notification_dead_letters")
export class NotificationDeadLetter {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  @Index("idx_notification_dead_letters_user_id")
  userId!: string;

  @Column({ type: "varchar", length: 32 })
  type!: string;

  @Column({ type: "varchar", length: 255 })
  title!: string;

  @Column({ type: "text" })
  message!: string;

  @Column({ type: "varchar", length: 32, default: NotificationDeadLetterStatus.PENDING })
  @Index("idx_notification_dead_letters_status")
  status!: NotificationDeadLetterStatus;

  @Column({ name: "attempt_count", type: "integer", default: 0 })
  attemptCount!: number;

  @Column({ name: "next_attempt_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  @Index("idx_notification_dead_letters_next_attempt")
  nextAttemptAt!: Date;

  @Column({ name: "last_error", type: "varchar", length: 500, nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
