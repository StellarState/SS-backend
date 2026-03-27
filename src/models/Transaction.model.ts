import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { TransactionType, TransactionStatus } from "../types/enums";
import type { Investment } from "./Investment.model";
import type { Invoice } from "./Invoice.model";

@Entity("transactions")
export class Transaction {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  @Index("idx_transactions_user_id")
  userId!: string;

  @Column({ name: "investment_id", type: "uuid", nullable: true })
  @Index("idx_transactions_investment_id")
  investmentId!: string | null;

  @Column({ name: "invoice_id", type: "uuid", nullable: true })
  @Index("idx_transactions_invoice_id")
  invoiceId!: string | null;

  @Column({
    type: "enum",
    enum: TransactionType,
  })
  @Index("idx_transactions_type")
  type!: TransactionType;

  @Column({ type: "decimal", precision: 18, scale: 4 })
  amount!: string;

  @Column({ name: "stellar_tx_hash", type: "varchar", length: 64, nullable: true })
  stellarTxHash!: string | null;

  @Column({ name: "stellar_operation_index", type: "integer", nullable: true })
  stellarOperationIndex!: number | null;

  @Column({
    type: "enum",
    enum: TransactionStatus,
    default: TransactionStatus.PENDING,
  })
  @Index("idx_transactions_status")
  status!: TransactionStatus;

  @Column({ type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  timestamp!: Date;

  @ManyToOne("User", "transactions", { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: import("./User.model").User;

  @ManyToOne("Investment", "transactions", { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "investment_id" })
  investment!: Investment | null;

  @ManyToOne("Invoice", "transactions", { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "invoice_id" })
  invoice!: Invoice | null;
}
