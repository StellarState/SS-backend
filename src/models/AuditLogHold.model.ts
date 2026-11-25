import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * Operational legal hold on a user's audit records. While a hold is active
 * (`releasedAt` is null) no `user_audit_logs` row for that subject is purged.
 */
@Entity("audit_log_holds")
@Index("idx_audit_log_holds_subject_active", ["subjectUserId"], { where: "released_at IS NULL" })
export class AuditLogHold {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "subject_user_id", type: "uuid" })
  subjectUserId!: string;

  @Column({ name: "placed_by_user_id", type: "uuid", nullable: true })
  placedByUserId!: string | null;

  @Column({ type: "text" })
  reason!: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @Column({ name: "released_at", type: "timestamptz", nullable: true })
  releasedAt!: Date | null;
}
