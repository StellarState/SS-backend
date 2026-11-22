import { Entity, PrimaryColumn, Column, CreateDateColumn } from "typeorm";

export type PayoutKind = "dividend" | "royalty";
export type PayoutStatus = "pending" | "succeeded" | "failed";

/** One immutable reservation per wallet, cycle and revision. No retry creates a new transfer. */
@Entity("payout_attempts")
export class PayoutAttempt {
  @PrimaryColumn({ type: "varchar", length: 64 }) key!: string;
  @Column({ type: "varchar", length: 20 }) kind!: PayoutKind;
  @Column({ type: "varchar", length: 56 }) wallet!: string;
  @Column({ name: "cycle_id", type: "varchar", length: 128 }) cycleId!: string;
  @Column({ type: "integer" }) revision!: number;
  @Column({ name: "snapshot_id", type: "uuid", nullable: true }) snapshotId!: string | null;
  @Column({ type: "decimal", precision: 18, scale: 4 }) gross!: string;
  @Column({ name: "platform_fee", type: "decimal", precision: 18, scale: 4 }) platformFee!: string;
  @Column({ type: "decimal", precision: 18, scale: 4 }) net!: string;
  @Column({ type: "varchar", length: 20, default: "pending" }) status!: PayoutStatus;
  @Column({ name: "tx_hash", type: "varchar", length: 64, nullable: true }) txHash!: string | null;
  @Column({ name: "failure_code", type: "varchar", length: 64, nullable: true }) failureCode!:
    string | null;
  @Column({ name: "last_checked_at", type: "timestamptz", nullable: true })
  lastCheckedAt!: Date | null;

  @CreateDateColumn({ name: "created_at" }) createdAt!: Date;
}
