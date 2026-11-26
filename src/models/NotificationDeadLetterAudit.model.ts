import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("notification_dead_letter_audits")
@Index("idx_notification_dead_letter_audits_event_created", ["eventId", "createdAt"])
export class NotificationDeadLetterAudit {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "event_id", type: "varchar", length: 191 })
  eventId!: string;

  @Column({ name: "actor_id", type: "varchar", length: 128 })
  actorId!: string;

  @Column({ type: "varchar", length: 16 })
  action!: "replayed" | "discarded";

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
