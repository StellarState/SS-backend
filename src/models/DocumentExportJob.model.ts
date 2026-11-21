import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";

export type DocumentExportJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

@Entity("document_export_jobs")
@Index("idx_document_export_jobs_status_lease", ["status", "leaseExpiresAt"])
@Index("idx_document_export_jobs_expiry", ["status", "expiresAt"])
export class DocumentExportJob {
  @PrimaryColumn({ type: "varchar", length: 160 })
  id!: string;

  @Column({ name: "invoice_id", type: "uuid" })
  invoiceId!: string;

  @Column({ name: "requester_id", type: "uuid" })
  requesterId!: string;

  @Column({ name: "progress", type: "integer", default: 0 })
  progress!: number;

  @Column({ name: "total_documents", type: "integer", default: 0 })
  totalDocuments!: number;

  @Column({ name: "processed_documents", type: "integer", default: 0 })
  processedDocuments!: number;

  @Column({ type: "varchar", length: 24 })
  status!: DocumentExportJobStatus;

  @Column({ name: "zip_path", type: "varchar", length: 1024, nullable: true })
  zipPath!: string | null;

  @Column({ name: "download_token", type: "varchar", length: 512, nullable: true })
  downloadToken!: string | null;

  @Column({ name: "download_token_expires_at", type: "timestamptz", nullable: true })
  downloadTokenExpiresAt!: Date | null;

  @Column({ type: "text", nullable: true })
  error!: string | null;

  @Column({ name: "lease_owner", type: "varchar", length: 64, nullable: true })
  leaseOwner!: string | null;

  @Column({ name: "lease_expires_at", type: "timestamptz", nullable: true })
  leaseExpiresAt!: Date | null;

  @Column({ name: "expires_at", type: "timestamptz", nullable: true })
  expiresAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @Column({ name: "completed_at", type: "timestamptz", nullable: true })
  completedAt!: Date | null;

  @Column({ name: "cancelled_at", type: "timestamptz", nullable: true })
  cancelledAt!: Date | null;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
