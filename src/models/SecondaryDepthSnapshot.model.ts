import { Entity, PrimaryGeneratedColumn, Column, Index } from "typeorm";

export interface DepthLevel {
  price: string;
  quantity: string;
  listing_count: number;
}

@Entity("secondary_depth_snapshots")
@Index("idx_secondary_depth_invoice_id", ["invoiceId", "id"])
export class SecondaryDepthSnapshot {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  @Column({ name: "invoice_id", type: "uuid" })
  invoiceId!: string;

  @Column({ type: "jsonb" })
  levels!: DepthLevel[];

  @Column({ name: "captured_at", type: "timestamptz" })
  capturedAt!: Date;

  @Column({ name: "valid_until", type: "timestamptz", nullable: true })
  validUntil!: Date | null;
}
