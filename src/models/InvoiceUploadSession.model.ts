import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, Index } from "typeorm";
import type { Invoice } from "./Invoice.model";

export type UploadState = "pending" | "complete" | "restarted";

@Entity("invoice_upload_sessions")
@Index("idx_upload_sessions_invoice", ["invoiceId"])
export class InvoiceUploadSession {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ name: "invoice_id", type: "uuid" })
  invoiceId!: string;

  @ManyToOne("Invoice", { onDelete: "RESTRICT" })
  @JoinColumn({ name: "invoice_id" })
  invoice!: Invoice;

  @Column({ type: "varchar", length: 255 })
  filename!: string;

  @Column({ name: "mime_type", type: "varchar", length: 128 })
  mimeType!: string;

  @Column({ name: "file_size_bytes", type: "integer" })
  fileSizeBytes!: number;

  @Column({ name: "content_checksum", type: "varchar", length: 64, nullable: true })
  contentChecksum!: string | null;

  @Column({ name: "received_bytes", type: "integer", default: 0 })
  receivedBytes!: number;

  @Column({ type: "varchar", length: 16, default: "pending" })
  state!: UploadState;

  @Column({ type: "varchar", length: 128, nullable: true })
  cid!: string | null;
}

@Entity("invoice_upload_chunks")
export class InvoiceUploadChunk {
  @PrimaryColumn({ name: "session_id", type: "uuid" })
  sessionId!: string;

  @ManyToOne(() => InvoiceUploadSession, { onDelete: "CASCADE" })
  @JoinColumn({ name: "session_id" })
  session!: InvoiceUploadSession;

  @PrimaryColumn({ type: "integer" })
  offset!: number;

  @Column({ type: "bytea" })
  bytes!: Buffer;
}
