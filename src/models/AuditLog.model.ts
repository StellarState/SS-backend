import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("audit_logs")
@Index("idx_audit_logs_actor_id", ["actor", "id"])
@Index("idx_audit_logs_action_id", ["action", "id"])
@Index("idx_audit_logs_resource_id", ["resource", "id"])
export class AuditLog {
  @PrimaryGeneratedColumn("increment", { type: "bigint" })
  id!: string;

  @Column({ type: "varchar", length: 128 })
  actor!: string;

  @Column({ type: "varchar", length: 128 })
  action!: string;

  @Column({ type: "varchar", length: 255 })
  resource!: string;

  @Column({ type: "jsonb", nullable: true })
  before!: Record<string, unknown> | null;

  @Column({ type: "jsonb", nullable: true })
  after!: Record<string, unknown> | null;

  @Column({ name: "prev_hash", type: "varchar", length: 64 })
  prevHash!: string;

  @Column({ type: "varchar", length: 64, unique: true })
  hash!: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
