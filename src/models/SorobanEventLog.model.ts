import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("soroban_event_logs")
@Index("uq_soroban_event_logs_contract_event", ["contractId", "eventId"], { unique: true })
export class SorobanEventLog {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "contract_id", type: "varchar", length: 56 })
  contractId!: string;

  @Column({ name: "event_id", type: "varchar", length: 255, nullable: true })
  eventId!: string | null;

  @Column({ name: "ledger_sequence", type: "bigint" })
  ledgerSequence!: string;

  @Column({ type: "varchar", length: 64 })
  topic!: string;

  @Column({ name: "tx_hash", type: "varchar", length: 64 })
  txHash!: string;

  @Column({ type: "jsonb", nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ type: "boolean", default: false })
  @Index("idx_soroban_event_logs_processed")
  processed!: boolean;

  /** Ingestion time: when the indexer first saw the event. */
  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  /**
   * Ledger close time (issue #812). Authoritative: the first valid value is
   * kept and a replay never replaces it. Null for legacy rows and for
   * quarantined events.
   */
  @Column({ name: "ledger_closed_at", type: "timestamptz", nullable: true })
  ledgerClosedAt!: Date | null;

  /** When the event was first processed successfully. Lag = processedAt - ledgerClosedAt. */
  @Column({ name: "processed_at", type: "timestamptz", nullable: true })
  processedAt!: Date | null;

  /** Why the event was quarantined instead of processed, e.g. an invalid ledger time. */
  @Column({ name: "quarantine_reason", type: "varchar", length: 64, nullable: true })
  quarantineReason!: string | null;

  @Column({ name: "quarantined_at", type: "timestamptz", nullable: true })
  quarantinedAt!: Date | null;
}
