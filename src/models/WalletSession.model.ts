import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

/**
 * One row per issued login token. `id` is the token's `jti` claim. Only
 * redacted metadata is stored: a coarse device label and a masked network
 * prefix, never the raw user agent or client IP.
 */
@Entity("wallet_sessions")
@Index("idx_wallet_sessions_wallet_created", ["wallet", "createdAt"])
export class WalletSession {
  @PrimaryColumn({ type: "uuid" })
  id!: string;

  @Column({ type: "varchar", length: 56 })
  wallet!: string;

  @Column({ name: "device_label", type: "varchar", length: 120 })
  deviceLabel!: string;

  @Column({ name: "network_prefix", type: "varchar", length: 64, nullable: true })
  networkPrefix!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @Column({ name: "expires_at", type: "timestamptz" })
  expiresAt!: Date;

  @Column({ name: "revoked_at", type: "timestamptz", nullable: true })
  revokedAt!: Date | null;
}
