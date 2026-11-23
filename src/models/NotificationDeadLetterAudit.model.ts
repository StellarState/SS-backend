import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("notification_dead_letter_audits")
export class NotificationDeadLetterAudit {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "dead_letter_id", type: "uuid" })
  @Index("idx_notification_dead_letter_audits_dead_letter_id")
  deadLetterId!: string;

  @Column({ type: "varchar", length: 32 })
  action!: "attempt" | "delivered" | "replay" | "discard" | "dead";

  @Column({ name: "actor_id", type: "varchar", length: 255, nullable: true })
  actorId!: string | null;

  @Column({ type: "boolean" })
  success!: boolean;

  @Column({ name: "error_code", type: "varchar", length: 64, nullable: true })
  errorCode!: string | null;

  @Column({ name: "error_message", type: "varchar", length: 500, nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
