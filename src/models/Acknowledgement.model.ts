import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Records an investor's acknowledgement of accreditation / terms for a
 * specific `termsVersion`. History is retained (never updated/deleted) for
 * audit purposes — a new terms version simply produces a new row, and the
 * "current" acknowledgement is the most recent row per user.
 */
@Entity("investor_acknowledgements")
@Index("idx_acknowledgements_user_terms", ["userId", "termsVersion"])
export class Acknowledgement {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  @Index("idx_acknowledgements_user_id")
  userId!: string;

  @Column({ name: "terms_version", type: "varchar", length: 32 })
  termsVersion!: string;

  @CreateDateColumn({ name: "acknowledged_at" })
  acknowledgedAt!: Date;
}
