import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToMany,
  Index,
} from "typeorm";
import { UserType, KYCStatus } from "../types/enums";

@Entity("users")
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "stellarAddress", type: "varchar", length: 56, unique: true })
  @Index("idx_users_stellar_address", { unique: true })
  stellarAddress!: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  email!: string | null;

  @Column({
    name: "userType",
    type: "enum",
    enum: UserType,
    default: UserType.INVESTOR,
  })
  @Index("idx_users_user_type")
  userType!: UserType;

  @Column({
    name: "kycStatus",
    type: "enum",
    enum: KYCStatus,
    default: KYCStatus.PENDING,
  })
  @Index("idx_users_kyc_status")
  kycStatus!: KYCStatus;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @DeleteDateColumn({ name: "deleted_at" })
  deletedAt!: Date | null;

  @OneToMany("Invoice", "seller")
  invoices!: import("./Invoice.model").Invoice[];

  @OneToMany("Investment", "investor")
  investments!: import("./Investment.model").Investment[];

  @OneToMany("Transaction", "user")
  transactions!: import("./Transaction.model").Transaction[];

  @OneToMany("KYCVerification", "user")
  kycVerifications!: import("./KYCVerification.model").KYCVerification[];

  @OneToMany("Notification", "user")
  notifications!: import("./Notification.model").Notification[];
}
