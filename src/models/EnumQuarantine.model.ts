import { Column, Entity, PrimaryColumn } from "typeorm";

/** Compact operator record, never the full source row or event payload. */
@Entity("enum_quarantine")
export class EnumQuarantine {
  @PrimaryColumn({ type: "varchar", length: 64 }) id!: string;
  @Column({ name: "source_table", type: "varchar", length: 128 }) sourceTable!: string;
  @Column({ name: "source_column", type: "varchar", length: 128 }) sourceColumn!: string;
  @Column({ name: "record_id", type: "varchar", length: 512 }) recordId!: string;
  @Column({ name: "raw_value", type: "varchar", length: 256 }) rawValue!: string;
  @Column({ name: "correlation_id", type: "varchar", length: 128 }) correlationId!: string;
  @Column({ name: "observed_at", type: "timestamptz" }) observedAt!: Date;
}
