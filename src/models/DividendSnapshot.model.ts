import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from "typeorm";

export interface SnapshotAllocation {
  allocationId: string;
  legacyAllocationId?: string;
  wallet: string;
  amount: string;
}

/** Immutable values from one contract cycle revision; jobs only change their progress. */
@Entity("dividend_snapshots")
@Index("idx_dividend_reconciliation_due", ["reconciliationStatus", "retryAt"])
@Index("uq_dividend_snapshot_revision", ["contractId", "cycleId", "revision"], { unique: true })
export class DividendSnapshot {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "contract_id", type: "varchar", length: 128 }) contractId!: string;
  @Column({ name: "cycle_id", type: "varchar", length: 128 }) cycleId!: string;
  @Column({ type: "integer" }) revision!: number;
  @Column({ name: "issuer_wallet", type: "varchar", length: 56 }) issuerWallet!: string;
  @Column({ name: "snapshot_hash", type: "varchar", length: 64 }) snapshotHash!: string;
  @Column({ type: "simple-json" }) allocations!: SnapshotAllocation[];
  @Column({ name: "total_amount", type: "decimal", precision: 18, scale: 4 }) totalAmount!: string;
  @Column({ name: "contract_total", type: "decimal", precision: 18, scale: 4, nullable: true })
  contractTotal!: string | null;
  @Column({ name: "contract_claimed", type: "decimal", precision: 18, scale: 4, nullable: true })
  contractClaimed!: string | null;
  @Column({ name: "is_current", type: "boolean", default: true }) isCurrent!: boolean;
  @Column({ type: "boolean", default: false }) locked!: boolean;
  @Column({ name: "cycle_frequency", type: "varchar", length: 20, nullable: true })
  cycleFrequency!: string | null;
  @Column({ name: "tx_hash", type: "varchar", length: 64, nullable: true }) txHash!: string | null;
  @Column({ name: "ledger_sequence", type: "bigint", nullable: true }) ledgerSequence!:
    string | null;
  @Column({ name: "distributed_at", type: "timestamptz" }) distributedAt!: Date;
  @Column({ name: "reconciliation_status", type: "varchar", length: 20, default: "pending" })
  reconciliationStatus!: string;
  @Column({ name: "retry_count", type: "integer", default: 0 }) retryCount!: number;
  @Column({ name: "retry_at", type: "timestamptz", nullable: true }) retryAt!: Date | null;
  @Column({ type: "simple-json", nullable: true }) report!: Record<string, unknown> | null;
  @CreateDateColumn({ name: "created_at" }) createdAt!: Date;
}
