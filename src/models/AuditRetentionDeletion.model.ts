import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/** Append-only record of each purge batch: what was removed, when, and under which cutoff. */
@Entity("audit_retention_deletions")
@Index("idx_audit_retention_deletions_run", ["runId", "batchIndex"])
export class AuditRetentionDeletion {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "run_id", type: "uuid" })
  runId!: string;

  @Column({ name: "batch_index", type: "integer" })
  batchIndex!: number;

  @Column({ type: "varchar", length: 64 })
  category!: string;

  @Column({ type: "timestamptz" })
  cutoff!: Date;

  @Column({ name: "deleted_count", type: "integer" })
  deletedCount!: number;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
