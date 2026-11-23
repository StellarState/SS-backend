import { randomUUID } from "crypto";
import Decimal from "decimal.js";
import { DataSource, EntityManager } from "typeorm";
import { InvoiceFraudReport, FraudReportStatus } from "../models/InvoiceFraudReport.model";
import { Referral } from "../models/Referral.model";
import { WaitlistEntry } from "../models/WaitlistEntry.model";
import { WaitlistReferralCredit } from "../models/WaitlistReferralCredit.model";
import { AppError } from "../utils/http-error";
import { orderWaitlistQueue } from "./waitlist-order";

type WaitlistReferralStatus =
  | "not_provided"
  | "credited"
  | "already_credited"
  | "unknown_code"
  | "self_referral"
  | "duplicate_signup";

function isUniqueConstraintViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const driverError = "driverError" in error ? error.driverError : error;
  if (!driverError || typeof driverError !== "object") return false;

  const code = "code" in driverError ? driverError.code : undefined;
  const message = "message" in driverError && typeof driverError.message === "string"
    ? driverError.message
    : "";
  return code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE" ||
    (code === "SQLITE_CONSTRAINT" && message.includes("UNIQUE constraint failed"));
}

export class CommunityProgramsService {
  private sqliteTransactionQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataSource: DataSource) {}

  async createFraudReport(input: { invoiceId: string; wallet: string; reason: string; detail: string }) {
    if (!input.reason || input.reason.length > 64 || !input.detail || input.detail.length > 4000) {
      throw new AppError(400, "reason and detail are required and must be within the allowed length", "COMMUNITY_PROGRAM_VALIDATION_ERROR");
    }
    const repository = this.dataSource.getRepository(InvoiceFraudReport);
    const existing = await repository.findOne({ where: { invoiceId: input.invoiceId, reporterWallet: input.wallet } });
    if (existing) throw new AppError(409, "A report already exists for this wallet and invoice", "FRAUD_REPORT_DUPLICATE");
    return repository.save(repository.create({ ...input, reporterWallet: input.wallet, status: FraudReportStatus.OPEN, reviewNote: null }));
  }

  listFraudReports(page: number, pageSize: number) {
    return this.dataSource.getRepository(InvoiceFraudReport).findAndCount({
      order: { createdAt: "DESC" }, skip: (page - 1) * pageSize, take: pageSize,
    });
  }

  async reviewFraudReport(id: string, status: FraudReportStatus, reviewNote?: string) {
    if (![FraudReportStatus.INVESTIGATING, FraudReportStatus.RESOLVED, FraudReportStatus.DISMISSED].includes(status)) {
      throw new AppError(400, "Invalid report status", "COMMUNITY_PROGRAM_VALIDATION_ERROR");
    }
    const repository = this.dataSource.getRepository(InvoiceFraudReport);
    const report = await repository.findOneBy({ id });
    if (!report) throw new AppError(404, "Fraud report not found", "FRAUD_REPORT_NOT_FOUND");
    report.status = status;
    report.reviewNote = reviewNote?.trim().slice(0, 4000) ?? null;
    return repository.save(report);
  }

  async registerReferral(referrerWallet: string, refereeWallet: string) {
    if (!referrerWallet || !refereeWallet || referrerWallet === refereeWallet) {
      throw new AppError(400, "A referral must link two different wallets", "COMMUNITY_PROGRAM_VALIDATION_ERROR");
    }
    const repository = this.dataSource.getRepository(Referral);
    const existing = await repository.findOne({ where: { refereeWallet } });
    if (existing) return existing;
    return repository.save(repository.create({ referrerWallet, refereeWallet, earnedAmount: "0", claimedAmount: "0" }));
  }

  async referralStats(wallet: string) {
    const referrals = await this.dataSource.getRepository(Referral).find({ where: { referrerWallet: wallet }, order: { createdAt: "DESC" } });
    const earned = referrals.reduce((sum, row) => sum.plus(row.earnedAmount), new Decimal(0));
    const claimed = referrals.reduce((sum, row) => sum.plus(row.claimedAmount), new Decimal(0));
    return { totalReferees: referrals.length, earned: earned.toFixed(4), pending: earned.minus(claimed).toFixed(4), history: referrals };
  }

  async buildReferralClaim(wallet: string) {
    const stats = await this.referralStats(wallet);
    if (new Decimal(stats.pending).lte(0)) {
      throw new AppError(409, "No referral rewards are available to claim", "REFERRAL_CLAIM_UNAVAILABLE");
    }
    return {
      wallet,
      amount: stats.pending,
      // The signing key stays with the wallet client; the API only returns a
      // deterministic claim intent for the configured reward contract.
      unsignedTransaction: { type: "referral_reward_claim", wallet, amount: stats.pending },
    };
  }

  async registerWaitlist(wallet: string, email: string, referralCode?: string) {
    if (!wallet || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AppError(400, "A valid wallet and email are required", "COMMUNITY_PROGRAM_VALIDATION_ERROR");
    }
    if (referralCode !== undefined && typeof referralCode !== "string") {
      throw new AppError(400, "Referral code must be a string", "COMMUNITY_PROGRAM_VALIDATION_ERROR");
    }
    let result: { entry: WaitlistEntry; created: boolean; referralStatus: WaitlistReferralStatus };
    try {
      result = await this.runWaitlistTransaction(async (manager) => {
        const repository = manager.getRepository(WaitlistEntry);
        let entry = await repository.findOne({ where: { wallet } });
        let created = false;
        let referralStatus: WaitlistReferralStatus = "duplicate_signup";

        if (!entry) {
          let referrer: WaitlistEntry | null = null;
          if (referralCode) {
            referrer = await repository.findOne({ where: { referralCode } });
            if (!referrer) referralStatus = "unknown_code";
            else if (referrer.wallet === wallet) {
              referrer = null;
              referralStatus = "self_referral";
            }
          } else {
            referralStatus = "not_provided";
          }

          entry = repository.create({
            wallet,
            email,
            referralCode: `${wallet.slice(0, 8)}-${randomUUID()}`,
            referredByCode: referrer?.referralCode ?? null,
            referralCount: 0,
            status: "pending",
          });
          entry = await repository.save(entry);
          created = true;

          if (referrer) {
            const recorded = await this.recordReferralCredit(manager, entry);
            referralStatus = recorded ? "credited" : "already_credited";
          }
        } else if (entry.referredByCode) {
          const recorded = await this.recordReferralCredit(manager, entry);
          referralStatus = recorded ? "credited" : "already_credited";
        } else if (referralCode) {
          const referrer = await repository.findOne({ where: { referralCode } });
          if (referrer?.wallet === wallet) referralStatus = "self_referral";
        }

        return { entry, created, referralStatus };
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;

      result = await this.runWaitlistTransaction(async (manager) => {
        const repository = manager.getRepository(WaitlistEntry);
        const entry = await repository.findOne({ where: { wallet } });
        if (!entry) throw error;
        const recorded = entry.referredByCode
          ? await this.recordReferralCredit(manager, entry)
          : false;
        return {
          entry,
          created: false,
          referralStatus: entry.referredByCode
            ? recorded ? "credited" : "already_credited"
            : "duplicate_signup",
        };
      });
    }

    return {
      ...(await this.waitlistView(result.entry)),
      created: result.created,
      referralStatus: result.referralStatus,
    };
  }

  async waitlistView(entry: WaitlistEntry) {
    let position: number | null = null;
    if (entry.status === "pending") {
      const pendingEntries = await orderWaitlistQueue(
        this.dataSource.getRepository(WaitlistEntry).createQueryBuilder("waitlist"),
        "waitlist",
      )
        .where("waitlist.status = :status", { status: "pending" })
        .getMany();
      const index = pendingEntries.findIndex((pending) => pending.id === entry.id);
      if (index >= 0) position = index + 1;
    }

    return {
      wallet: entry.wallet,
      position,
      referralCount: entry.referralCount,
      referralCode: entry.referralCode,
      status: entry.status,
    };
  }

  async recordWaitlistReferral(referralCode: string, signupWallet: string) {
    if (!referralCode || !signupWallet) {
      throw new AppError(400, "A referral code and signup wallet are required", "COMMUNITY_PROGRAM_VALIDATION_ERROR");
    }

    try {
      return await this.runWaitlistTransaction(async (manager) => {
        const entry = await manager.getRepository(WaitlistEntry).findOne({ where: { wallet: signupWallet } });
        if (!entry) return { recorded: false, reason: "signup_not_found" as const };
        const referrer = await manager.getRepository(WaitlistEntry).findOne({ where: { referralCode } });
        if (!referrer) return { recorded: false, reason: "unknown_code" as const };
        if (referrer.wallet === signupWallet) return { recorded: false, reason: "self_referral" as const };
        if (entry.referredByCode !== referralCode) {
          return { recorded: false, reason: "referral_mismatch" as const };
        }
        const recorded = await this.recordReferralCredit(manager, entry);
        return { recorded, reason: recorded ? "recorded" as const : "already_recorded" as const };
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      return { recorded: false, reason: "already_recorded" as const };
    }
  }

  private async recordReferralCredit(
    manager: EntityManager,
    signup: WaitlistEntry,
  ): Promise<boolean> {
    if (!signup.referredByCode) return false;

    const credits = manager.getRepository(WaitlistReferralCredit);
    const existing = await credits.findOne({ where: { signupWallet: signup.wallet } });
    if (existing) return false;

    const referrer = await manager.getRepository(WaitlistEntry).findOne({
      where: { referralCode: signup.referredByCode },
    });
    if (!referrer || referrer.wallet === signup.wallet) return false;

    await credits.save(credits.create({
      signupWallet: signup.wallet,
      referrerWallet: referrer.wallet,
      referralCode: signup.referredByCode,
    }));
    const update = await manager.getRepository(WaitlistEntry).increment(
      { wallet: referrer.wallet },
      "referralCount",
      1,
    );
    if (update.affected !== 1) {
      throw new Error("Waitlist referrer could not be updated");
    }
    return true;
  }

  private async runWaitlistTransaction<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    if (this.dataSource.options.type !== "sqlite") {
      return this.dataSource.transaction(work);
    }

    // TypeORM's SQLite driver uses one connection, so overlapping transactions
    // on that connection must be serialized.
    const previous = this.sqliteTransactionQueue;
    let release!: () => void;
    this.sqliteTransactionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.dataSource.transaction(work);
    } finally {
      release();
    }
  }

  async approveWaitlist(wallet: string) {
    const repository = this.dataSource.getRepository(WaitlistEntry);
    const entry = await repository.findOne({ where: { wallet } });
    if (!entry) throw new AppError(404, "Waitlist entry not found", "WAITLIST_ENTRY_NOT_FOUND");
    entry.status = "approved";
    return repository.save(entry);
  }
}
