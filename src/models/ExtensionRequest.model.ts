import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import type { Invoice } from "./Invoice.model";

export enum ExtensionRequestStatus {
  PENDING = "pending",
  APPROVED = "approved",
  REJECTED = "rejected",
}

@Entity("extension_requests")
export class ExtensionRequest {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "invoice_id", type: "uuid" })
  @Index("idx_extension_requests_invoice_id")
  invoiceId!: string;

  @Column({ name: "requested_by", type: "uuid" })
  requestedBy!: string;

  @Column({ name: "current_deadline", type: "date" })
  currentDeadline!: Date;

  @Column({ name: "proposed_deadline", type: "date" })
  proposedDeadline!: Date;

  @Column({
    type: "enum",
    enum: ExtensionRequestStatus,
    default: ExtensionRequestStatus.PENDING,
  })
  @Index("idx_extension_requests_status")
  status!: ExtensionRequestStatus;

  @Column({ name: "reviewed_by", type: "uuid", nullable: true })
  reviewedBy!: string | null;

  @Column({ name: "reviewed_at", type: "timestamptz", nullable: true })
  reviewedAt!: Date | null;

  @Column({ name: "rejection_reason", type: "varchar", length: 255, nullable: true })
  rejectionReason!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @ManyToOne("Invoice", { onDelete: "CASCADE" })
  @JoinColumn({ name: "invoice_id" })
  invoice!: Invoice;
}
