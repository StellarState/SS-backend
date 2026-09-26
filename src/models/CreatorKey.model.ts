import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * A creator key registered on the token contract. Mirrors the on-chain
 * per-key configuration (buy caps, curve parameters) so the frontend can
 * enforce limits before a transaction is ever submitted.
 */
@Entity("creator_keys")
@Index("idx_creator_keys_creator_id", ["creatorId"])
@Index("idx_creator_keys_contract_address", ["contractAddress"], { unique: true })
export class CreatorKey {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Owner of the key (creator wallet / user id). */
  @Column({ name: "creator_id", type: "varchar", length: 128 })
  creatorId!: string;

  @Column({ name: "creator_wallet", type: "varchar", length: 56 })
  creatorWallet!: string;

  @Column({ name: "contract_address", type: "varchar", length: 56 })
  contractAddress!: string;

  /** Maximum amount purchasable in a single buy transaction, in base units. */
  @Column({ name: "max_buy_per_tx", type: "decimal", precision: 30, scale: 7, default: "0" })
  maxBuyPerTx!: string;

  /** Maximum amount purchasable per wallet per day, in base units. */
  @Column({ name: "max_buy_per_day", type: "decimal", precision: 30, scale: 7, default: "0" })
  maxBuyPerDay!: string;

  /** Current circulating supply of the key's token, in base units. */
  @Column({ name: "current_supply", type: "decimal", precision: 30, scale: 7, default: "0" })
  currentSupply!: string;

  @Column({ name: "curve_type", type: "varchar", length: 32, default: "constant_product" })
  curveType!: string;

  @Column({ name: "config_version", type: "integer", default: 0 })
  configVersion!: number;

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
