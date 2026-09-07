import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from "typeorm";
import { NotificationType } from "../types/enums";

@Entity("notifications")
export class Notification {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  @Index("idx_notifications_user_id")
  userId!: string;

  @Column({
    type: "enum",
    enum: NotificationType,
  })
  @Index("idx_notifications_type")
  type!: NotificationType;

  @Column({ type: "varchar", length: 255 })
  title!: string;

  @Column({ type: "text" })
  message!: string;

  @Column({ type: "boolean", default: false })
  read!: boolean;

  @Column({ type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  timestamp!: Date;

  @ManyToOne("User", "notifications", { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: import("./User.model").User;
}
