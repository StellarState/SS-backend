import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * A refresh token issued at login or on rotation (issue #563).
 *
 * Only the SHA-256 hash of the token is stored. Every token issued from one
 * login shares a `sessionId`, so a whole login session can be revoked at once.
 * A token is single use: rotating it sets `usedAt`, and presenting a token
 * that already has `usedAt` set is treated as a replay.
 */
@Entity("refresh_tokens")
export class RefreshToken {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "token_hash", type: "varchar", length: 64 })
  @Index("idx_refresh_tokens_token_hash", { unique: true })
  tokenHash!: string;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @Column({ name: "stellar_address", type: "varchar", length: 56 })
  @Index("idx_refresh_tokens_stellar_address")
  stellarAddress!: string;

  @Column({ name: "session_id", type: "uuid" })
  @Index("idx_refresh_tokens_session_id")
  sessionId!: string;

  @Column({ name: "expires_at", type: "timestamptz" })
  expiresAt!: Date;

  @Column({ name: "used_at", type: "timestamptz", nullable: true })
  usedAt!: Date | null;

  @Column({ name: "revoked_at", type: "timestamptz", nullable: true })
  revokedAt!: Date | null;

  @Column({ name: "replaced_by_id", type: "uuid", nullable: true })
  replacedById!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
