import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Stores indexed ReferralRewardPaid on-chain events.
 * Powers investor referral stats and cursor-paginated referral earnings history.
 */
@Entity("referral_earnings")
@Index("idx_referral_earnings_referrer_wallet", ["referrerWallet"])
@Index("idx_referral_earnings_referred_wallet", ["referredWallet"])
@Index("idx_referral_earnings_earned_at", ["earnedAt"])
@Index("idx_referral_earnings_referrer_earned_id", ["referrerWallet", "earnedAt", "id"])
export class ReferralEarning {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Unique on-chain Soroban event identifier for idempotent indexing */
  @Column({ name: "event_id", type: "varchar", length: 128, nullable: true, unique: true })
  eventId!: string | null;

  /** Investor wallet that earned the referral reward */
  @Column({ name: "referrer_wallet", type: "varchar", length: 56 })
  referrerWallet!: string;

  /** Wallet that was referred */
  @Column({ name: "referred_wallet", type: "varchar", length: 56 })
  referredWallet!: string;

  /** Referral reward amount paid (in platform currency units) */
  @Column({ name: "amount", type: "decimal", precision: 18, scale: 4 })
  amount!: string;

  /** On-chain transaction hash for this referral reward payment */
  @Column({ name: "tx_hash", type: "varchar", length: 64, nullable: true })
  @Index("idx_referral_earnings_tx_hash")
  txHash!: string | null;

  /** Ledger sequence this event was emitted in */
  @Column({ name: "ledger_sequence", type: "bigint", nullable: true })
  ledgerSequence!: string | null;

  /** Timestamp when the referral reward was paid */
  @Column({ name: "earned_at", type: "timestamptz" })
  earnedAt!: Date;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
