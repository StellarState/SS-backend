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
} from "typeorm";
import Decimal from "decimal.js";
import { InvoiceStatus } from "../types/enums";
import { logger } from "../observability/logger";
import { AppError } from "../utils/http-error";

export const VALID_INVOICE_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  [InvoiceStatus.DRAFT]: [InvoiceStatus.PUBLISHED, InvoiceStatus.CANCELLED, InvoiceStatus.REJECTED],
  [InvoiceStatus.PENDING]: [InvoiceStatus.PUBLISHED, InvoiceStatus.CANCELLED, InvoiceStatus.REJECTED],
  [InvoiceStatus.PUBLISHED]: [InvoiceStatus.FUNDED, InvoiceStatus.CANCELLED],
  [InvoiceStatus.FUNDED]: [InvoiceStatus.SETTLED, InvoiceStatus.CANCELLED],
  [InvoiceStatus.SETTLED]: [InvoiceStatus.CANCELLED],
  [InvoiceStatus.CANCELLED]: [],
  [InvoiceStatus.REJECTED]: [],
};

export interface PublicInvoiceDTO {
  id: string;
  sellerId: string;
  invoiceNumber: string;
  customerName: string;
  amount: string;
  discountRate: string;
  netAmount: string;
  dueDate: Date;
  ipfsHash: string | null;
  riskScore: string | null;
  status: InvoiceStatus;
  smartContractId: string | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Entity("invoices")
@Index("idx_invoices_seller_status_created", ["sellerId", "status", "createdAt"])
@Index("idx_invoices_status_due_date", ["status", "dueDate"])
@Index("idx_invoices_status_created_at", ["status", "createdAt"])
@Index("idx_invoices_status_amount", ["status", "amount"])
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
  @Index("idx_invoices_ipfs_hash")
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
  @Index("idx_invoices_smart_contract_id")
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

  /**
   * Calculates the exact net amount using arbitrary-precision decimal arithmetic.
   * Net Amount = amount * (1 - discountRate / 100) rounded to 4 decimal places.
   */
  static calculateNetAmount(
    amount: string | number | Decimal,
    discountRate: string | number | Decimal,
  ): string {
    try {
      const amt = new Decimal(amount);
      const disc = new Decimal(discountRate);

      if (
        !amt.isFinite() ||
        !disc.isFinite() ||
        amt.isNegative() ||
        disc.isNegative() ||
        disc.gt(100)
      ) {
        throw new AppError(
          400,
          "Amount must be non-negative and discount rate must be between 0 and 100",
          "INVALID_AMOUNT_OR_DISCOUNT",
        );
      }

      const net = amt.minus(amt.times(disc.dividedBy(100)));
      return net.toFixed(4);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      logger.error("Failed to calculate invoice net amount", {
        error: error instanceof Error ? error.message : String(error),
        amount: String(amount),
        discountRate: String(discountRate),
      });
      throw new AppError(
        500,
        "Failed to calculate invoice net amount",
        "NET_AMOUNT_CALCULATION_FAILED",
      );
    }
  }

  /**
   * Sanitizes and normalizes invoice fields to prevent data corruption.
   */
  static sanitizeAndNormalize(invoice: Partial<Invoice>): void {
    try {
      if (invoice.invoiceNumber !== undefined && invoice.invoiceNumber !== null) {
        invoice.invoiceNumber = String(invoice.invoiceNumber).trim().slice(0, 64);
      }

      if (invoice.customerName !== undefined && invoice.customerName !== null) {
        invoice.customerName = String(invoice.customerName).trim().slice(0, 255);
      }

      if (invoice.ipfsHash !== undefined && invoice.ipfsHash !== null) {
        const trimmed = String(invoice.ipfsHash).trim();
        invoice.ipfsHash = trimmed.length > 0 ? trimmed.slice(0, 128) : null;
      }

      if (invoice.smartContractId !== undefined && invoice.smartContractId !== null) {
        const trimmed = String(invoice.smartContractId).trim();
        invoice.smartContractId = trimmed.length > 0 ? trimmed.slice(0, 64) : null;
      }

      if (invoice.rejectionReason !== undefined && invoice.rejectionReason !== null) {
        const trimmed = String(invoice.rejectionReason).trim();
        invoice.rejectionReason = trimmed.length > 0 ? trimmed : null;
      }

      if (
        invoice.amount !== undefined &&
        invoice.discountRate !== undefined &&
        invoice.amount !== null &&
        invoice.discountRate !== null
      ) {
        const amtStr = String(invoice.amount).trim();
        const discStr = String(invoice.discountRate).trim();
        if (amtStr && discStr && !isNaN(Number(amtStr)) && !isNaN(Number(discStr))) {
          if (!invoice.netAmount || invoice.netAmount === "0" || invoice.netAmount === "0.0000") {
            invoice.netAmount = Invoice.calculateNetAmount(amtStr, discStr);
          }
        }
      }
    } catch (error) {
      logger.error("Failed to sanitize/normalize invoice entity", {
        error: error instanceof Error ? error.message : String(error),
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
      });
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        500,
        `Invoice normalization failed: ${error instanceof Error ? error.message : String(error)}`,
        "INVOICE_NORMALIZATION_FAILED",
      );
    }
  }

  /**
   * Checks if a transition from current status to target status is valid.
   */
  static isValidTransition(currentStatus: InvoiceStatus, targetStatus: InvoiceStatus): boolean {
    const current = currentStatus ?? InvoiceStatus.DRAFT;
    const allowed = VALID_INVOICE_TRANSITIONS[current] ?? [];
    return allowed.includes(targetStatus);
  }

  /**
   * Safely transitions the invoice status with validation.
   */
  static transitionTo(
    invoice: Invoice,
    targetStatus: InvoiceStatus,
    rejectionReason?: string | null,
  ): void {
    try {
      if (!Invoice.isValidTransition(invoice.status, targetStatus)) {
        throw new AppError(
          400,
          `Cannot transition invoice from ${invoice.status} to ${targetStatus}`,
          "INVALID_STATUS_TRANSITION",
        );
      }

      invoice.status = targetStatus;
      if (targetStatus === InvoiceStatus.REJECTED && rejectionReason) {
        invoice.rejectionReason = rejectionReason.trim();
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      logger.error("Failed to transition invoice status", {
        error: error instanceof Error ? error.message : String(error),
        invoiceId: invoice.id,
        fromStatus: invoice.status,
        toStatus: targetStatus,
      });
      throw new AppError(
        500,
        "Failed to execute invoice status transition",
        "STATUS_TRANSITION_FAILED",
      );
    }
  }

  /**
   * Evaluates if the invoice is eligible to be published to the marketplace.
   */
  static isPublishable(
    invoice: Partial<Invoice>,
    options: { referenceDate?: Date; minRunwayHours?: number } = {},
  ): {
    publishable: boolean;
    errors: string[];
  } {
    const errors: string[] = [];
    const minRunwayHours = options.minRunwayHours ?? 24;
    const now = options.referenceDate ?? new Date();

    if (invoice.status !== InvoiceStatus.DRAFT && invoice.status !== InvoiceStatus.PENDING) {
      errors.push(`Status must be draft or pending, currently ${invoice.status}`);
    }

    try {
      const amt = new Decimal(invoice.amount || 0);
      if (amt.lte(0)) {
        errors.push("Invoice amount must be greater than zero");
      }
    } catch {
      errors.push("Invalid amount format");
    }

    if (!invoice.customerName || !invoice.customerName.trim()) {
      errors.push("Customer name is required");
    }

    if (!invoice.dueDate) {
      errors.push("Due date is required");
    } else {
      const dueTime = new Date(invoice.dueDate).getTime();
      const minDueTime = now.getTime() + minRunwayHours * 60 * 60 * 1000;
      if (isNaN(dueTime)) {
        errors.push("Invalid due date format");
      } else if (dueTime < minDueTime) {
        errors.push(`Due date must be at least ${minRunwayHours} hours in the future`);
      }
    }

    if (!invoice.ipfsHash || !invoice.ipfsHash.trim()) {
      errors.push("Invoice document IPFS hash is required");
    }

    return {
      publishable: errors.length === 0,
      errors,
    };
  }

  /**
   * Checks if the invoice due date has passed.
   */
  static isOverdue(invoice: Partial<Invoice>, referenceDate: Date = new Date()): boolean {
    if (!invoice.dueDate) return false;
    const dueTime = new Date(invoice.dueDate).getTime();
    return !isNaN(dueTime) && dueTime < referenceDate.getTime();
  }

  /**
   * Calculates the remaining funding runway in hours.
   */
  static getFundingRunwayHours(
    invoice: Partial<Invoice>,
    referenceDate: Date = new Date(),
  ): number {
    if (!invoice.dueDate) return 0;
    const dueTime = new Date(invoice.dueDate).getTime();
    if (isNaN(dueTime)) return 0;
    const diffMs = dueTime - referenceDate.getTime();
    return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60)));
  }

  /**
   * Static factory method to safely construct and initialize an Invoice instance.
   */
  static create(data: Partial<Invoice>): Invoice {
    try {
      const invoice = new Invoice();
      Object.assign(invoice, data);
      Invoice.sanitizeAndNormalize(invoice);
      return invoice;
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.error("Failed to construct invoice entity", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppError(
        500,
        "Failed to construct invoice entity",
        "INVOICE_CONSTRUCTION_FAILED",
      );
    }
  }

  /**
   * Serializes entity to a clean DTO payload.
   */
  static toDTO(invoice: Invoice): PublicInvoiceDTO {
    return {
      id: invoice.id,
      sellerId: invoice.sellerId,
      invoiceNumber: invoice.invoiceNumber,
      customerName: invoice.customerName,
      amount: invoice.amount,
      discountRate: invoice.discountRate,
      netAmount: invoice.netAmount,
      dueDate: invoice.dueDate,
      ipfsHash: invoice.ipfsHash,
      riskScore: invoice.riskScore,
      status: invoice.status,
      smartContractId: invoice.smartContractId,
      rejectionReason: invoice.rejectionReason,
      createdAt: invoice.createdAt,
      updatedAt: invoice.updatedAt,
    };
  }
}

