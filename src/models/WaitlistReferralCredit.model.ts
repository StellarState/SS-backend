import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("waitlist_referral_credits")
@Index("uq_waitlist_referral_credit_signup", ["signupWallet"], { unique: true })
@Index("idx_waitlist_referral_credit_referrer", ["referrerWallet"])
export class WaitlistReferralCredit {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "signup_wallet", type: "varchar", length: 56 })
  signupWallet!: string;

  @Column({ name: "referrer_wallet", type: "varchar", length: 56 })
  referrerWallet!: string;

  @Column({ name: "referral_code", type: "varchar", length: 64 })
  referralCode!: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
