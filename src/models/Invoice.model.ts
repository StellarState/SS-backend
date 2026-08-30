import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
  BeforeInsert,
  BeforeUpdate,
} from "typeorm";
import Decimal from "decimal.js";
import { InvoiceStatus } from "../types/enums";
import { AppError } from "../utils/http-error";
import { logger } from "../observability/logger";

@Entity("invoices")
@Index("idx_invoices_status_seller_id", ["status", "sellerId"])
@Index("idx_invoices_status_due_date", ["status", "dueDate"])
@Index("idx_invoices_created_at", ["createdAt"])
export class Invoice {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "seller_id", type: "uuid" })
  @Index("idx_invoices_seller_id")
  sellerId!: string;

  @Column({ name: "invoice_number", type: "varchar", length: 64 })
  @Index("idx_invoices_invoice_number", { unique: true })
  invoiceNumber!: string;

  @Column({ name: "customer_name", type: "varchar", length: 255 })
  @Index("idx_invoices_customer_name")
  customerName!: string;

  @Column({ type: "decimal", precision: 18, scale: 4, default: 0 })
  amount!: string;

  @Column({ name: "discount_rate", type: "decimal", precision: 5, scale: 2, default: 0 })
  discountRate!: string;

  @Column({ name: "net_amount", type: "decimal", precision: 18, scale: 4, default: 0 })
  netAmount!: string;

  @Column({ name: "due_date", type: "date" })
  @Index("idx_invoices_due_date")
  dueDate!: Date;

  @Column({ name: "ipfs_hash", type: "varchar", length: 128, nullable: true })
  ipfsHash!: string | null;

  @Column({ name: "risk_score", type: "decimal", precision: 5, scale: 2, nullable: true })
  riskScore!: string | null;

  @Column({
    type: "enum",
    enum: InvoiceStatus,
    default: InvoiceStatus.DRAFT,
  })
  @Index("idx_invoices_status")
  status!: InvoiceStatus;

  @Column({ name: "smart_contract_id", type: "varchar", length: 64, nullable: true })
  smartContractId!: string | null;

  @Column({ name: "rejection_reason", type: "text", nullable: true })
  rejectionReason!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @DeleteDateColumn({ name: "deleted_at" })
  deletedAt!: Date | null;

  @ManyToOne("User", "invoices", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "seller_id" })
  seller!: import("./User.model").User;

  @OneToMany("Investment", "invoice")
  investments!: import("./Investment.model").Investment[];

  @OneToMany("Transaction", "invoice")
  transactions!: import("./Transaction.model").Transaction[];

  @BeforeInsert()
  @BeforeUpdate()
  calculateAndFormatAmounts(): void {
    try {
      this.sanitizeInputs();
      this.netAmount = this.calculateNetAmount();
    } catch (error) {
      logger.error("Failed to calculate invoice amounts", {
        invoiceId: this.id,
        invoiceNumber: this.invoiceNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppError(400, "Invalid invoice amount or discount rate formatting", "INVALID_INVOICE_AMOUNT");
    }
  }

  sanitizeInputs(): void {
    if (this.customerName) {
      this.customerName = this.customerName.trim();
    }
    if (this.invoiceNumber) {
      this.invoiceNumber = this.invoiceNumber.trim();
    }
    if (this.amount) {
      const parsedAmount = new Decimal(this.amount);
      if (parsedAmount.isNegative()) {
        throw new Error("Invoice amount cannot be negative");
      }
      this.amount = parsedAmount.toFixed(4);
    }
    if (this.discountRate) {
      const parsedDiscount = new Decimal(this.discountRate);
      if (parsedDiscount.isNegative() || parsedDiscount.greaterThan(100)) {
        throw new Error("Discount rate must be between 0 and 100");
      }
      this.discountRate = parsedDiscount.toFixed(2);
    }
  }

  calculateNetAmount(): string {
    const grossAmount = new Decimal(this.amount || "0");
    const rate = new Decimal(this.discountRate || "0");
    const discountMultiplier = new Decimal(1).minus(rate.dividedBy(100));
    return grossAmount.times(discountMultiplier).toFixed(4);
  }

  validateForPublish(): void {
    if (!this.ipfsHash) {
      throw new AppError(400, "Invoice document (IPFS hash) is required before publishing", "MISSING_IPFS_HASH");
    }
    if (new Date(this.dueDate).getTime() <= Date.now()) {
      throw new AppError(400, "Invoice due date must be in the future", "INVALID_DUE_DATE");
    }
  }

  static async processBatch(invoices: Invoice[]): Promise<Invoice[]> {
    try {
      logger.info("Processing batch of invoices", { count: invoices.length });
      for (const invoice of invoices) {
        invoice.calculateAndFormatAmounts();
      }
      return invoices;
    } catch (error) {
      logger.error("Failed to process invoice batch", { error: error instanceof Error ? error.message : String(error) });
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(500, "Processing invoice batch failed", "INVOICE_BATCH_PROCESSING_FAILED", error);
    }
  }
}
