import { Column, Entity, UpdateDateColumn } from "typeorm";

@Entity("soroban_indexer_checkpoints")
export class SorobanIndexerCheckpoint {
  @Column({ name: "checkpoint_key", type: "varchar", length: 255, primary: true })
  checkpointKey!: string;

  @Column({ name: "ledger_sequence", type: "bigint" })
  ledgerSequence!: string;

  @Column({ name: "lease_owner", type: "varchar", length: 128, nullable: true })
  leaseOwner!: string | null;

  @Column({ name: "lease_expires_at", type: "timestamptz", nullable: true })
  leaseExpiresAt!: Date | null;

  @Column({ name: "fencing_token", type: "bigint", default: 0 })
  fencingToken!: string;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
