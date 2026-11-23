import { Column, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import type { AlertEvent, NotificationChannel } from "../lib/notification-templates";

@Entity("alert_preferences")
export class AlertPreference {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 56, unique: true })
  wallet!: string;

  @Column({ name: "settlement_enabled", type: "boolean", default: true })
  settlementEnabled!: boolean;

  @Column({ name: "kyc_expiry_enabled", type: "boolean", default: true })
  kycExpiryEnabled!: boolean;

  @Column({ name: "watchlist_change_enabled", type: "boolean", default: true })
  watchlistChangeEnabled!: boolean;

  @Column({ name: "auto_invest_enabled", type: "boolean", default: true })
  autoInvestEnabled!: boolean;

  @Column({ name: "maturity_enabled", type: "boolean", default: true })
  maturityEnabled!: boolean;

  /**
   * Per-event delivery channels (issue #811). Null, or an event missing from
   * the map, means DEFAULT_ALERT_CHANNELS. Only registered pairs are stored.
   */
  @Column({ type: "jsonb", nullable: true })
  channels!: Partial<Record<AlertEvent, NotificationChannel[]>> | null;

  @Column({ name: "event_id", type: "varchar", length: 128, nullable: true })
  eventId!: string | null;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
