import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";

/**
 * Supported document types for registered invoice documents (issue #781).
 * Stored as varchar, so adding a type here needs no migration.
 */
export enum InvoiceDocumentType {
  INVOICE_PDF = "invoice_pdf",
  VERIFICATION_REPORT = "verification_report",
  ISSUER_CERT = "issuer_cert",
}

/**
 * One document for an invoice (issues #589, #781).
 *
 * `Invoice.ipfsHash` only ever held a single CID -- each new upload
 * overwrote it. This table lets an invoice carry several typed documents
 * (invoice PDF, verification report, issuer certificate, ...), registered by
 * IPFS CID. Rows are soft-deleted when the invoice is withdrawn; soft-deleted
 * rows are excluded from every TypeORM `find` automatically.
 */
@Entity("invoice_documents")
export class InvoiceDocument {
  @Column({ name: "content_checksum", type: "varchar", length: 64, nullable: true })
  contentChecksum!: string | null;

  @Column({ name: "upload_session_id", type: "uuid", nullable: true })
  uploadSessionId!: string | null;

  @Column({ name: "checksum_verified", type: "boolean", default: false })
  checksumVerified!: boolean;

  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "invoice_id", type: "uuid" })
  @Index("idx_invoice_documents_invoice_id")
  invoiceId!: string;

  @Column({ name: "cid", type: "varchar", length: 128 })
  cid!: string;

  @Column({ name: "doc_type", type: "varchar", length: 64, default: "general" })
  docType!: string;

  @Column({ name: "filename", type: "varchar", length: 255, nullable: true })
  filename!: string | null;

  @Column({ name: "mime_type", type: "varchar", length: 128, nullable: true })
  mimeType!: string | null;

  @Column({ name: "file_size", type: "integer" })
  fileSize!: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @DeleteDateColumn({ name: "deleted_at", type: "timestamptz", nullable: true })
  deletedAt!: Date | null;

  @ManyToOne("Invoice", { onDelete: "CASCADE" })
  @JoinColumn({ name: "invoice_id" })
  invoice!: import("./Invoice.model").Invoice;
}
