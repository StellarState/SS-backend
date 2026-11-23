import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("yield_adjustments")
@Index("idx_yield_adjustments_invoice_settled", ["invoiceId", "settledAt"])
export class YieldAdjustment {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "invoice_id", type: "varchar", length: 64 })
  invoiceId!: string;

  @Column({ name: "settlement_event_id", type: "varchar", length: 128, unique: true })
  settlementEventId!: string;

  @Column({ name: "adjustment_bps", type: "integer", default: 0 })
  adjustmentBps!: number;

  @Column({ name: "basis_rating", type: "decimal", precision: 12, scale: 4, nullable: true })
  basisRating!: string | null;

  @Column({ name: "adjusted_yield", type: "decimal", precision: 12, scale: 6, nullable: true })
  adjustedYield!: string | null;

  /** Ledger close time of the settlement event. Set once; replays never change it. */
  @Column({ name: "settled_at", type: "timestamptz" })
  settledAt!: Date;

  /**
   * When the settlement was first projected (issue #812). Kept on replay so
   * processing lag (processedAt - settledAt) stays meaningful. Null for legacy rows.
   */
  @Column({ name: "processed_at", type: "timestamptz", nullable: true })
  processedAt!: Date | null;

  @Column({ name: "transaction_hash", type: "varchar", length: 128 })
  transactionHash!: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
