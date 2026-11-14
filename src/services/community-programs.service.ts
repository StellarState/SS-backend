import { DataSource } from "typeorm";
import Decimal from "decimal.js";
import { InvoiceFraudReport, FraudReportStatus } from "../models/InvoiceFraudReport.model";
import { Referral } from "../models/Referral.model";
import { WaitlistEntry } from "../models/WaitlistEntry.model";
import { AppError } from "../utils/http-error";

export const COMMUNITY_PROGRAM_ERROR_CODES = {
  INVALID_FRAUD_REPORT: "INVALID_FRAUD_REPORT",
  DUPLICATE_FRAUD_REPORT: "DUPLICATE_FRAUD_REPORT",
  INVALID_FRAUD_REPORT_STATUS: "INVALID_FRAUD_REPORT_STATUS",
  FRAUD_REPORT_NOT_FOUND: "FRAUD_REPORT_NOT_FOUND",
  INVALID_REFERRAL: "INVALID_REFERRAL",
  NO_AVAILABLE_REFERRAL_REWARDS: "NO_AVAILABLE_REFERRAL_REWARDS",
  INVALID_WAITLIST_REGISTRATION: "INVALID_WAITLIST_REGISTRATION",
  WAITLIST_ENTRY_NOT_FOUND: "WAITLIST_ENTRY_NOT_FOUND",
} as const;

export class CommunityProgramsService {
  constructor(private readonly dataSource: DataSource) {}

  async createFraudReport(input: {
    invoiceId: string;
    wallet: string;
    reason: string;
    detail: string;
  }) {
    if (!input.reason || input.reason.length > 64 || !input.detail || input.detail.length > 4000) {
      throw new AppError(
        400,
        "reason and detail are required and must be within the allowed length",
        COMMUNITY_PROGRAM_ERROR_CODES.INVALID_FRAUD_REPORT
      );
    }
    const repository = this.dataSource.getRepository(InvoiceFraudReport);
    const existing = await repository.findOne({
      where: { invoiceId: input.invoiceId, reporterWallet: input.wallet },
    });
    if (existing) {
      throw new AppError(
        409,
        "A report already exists for this wallet and invoice",
        COMMUNITY_PROGRAM_ERROR_CODES.DUPLICATE_FRAUD_REPORT
      );
    }
    return repository.save(
      repository.create({
        ...input,
        reporterWallet: input.wallet,
        status: FraudReportStatus.OPEN,
        reviewNote: null,
      })
    );
  }

  listFraudReports(page: number, pageSize: number) {
    return this.dataSource.getRepository(InvoiceFraudReport).findAndCount({
      order: { createdAt: "DESC" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
  }

  async reviewFraudReport(id: string, status: FraudReportStatus, reviewNote?: string) {
    if (
      ![
        FraudReportStatus.INVESTIGATING,
        FraudReportStatus.RESOLVED,
        FraudReportStatus.DISMISSED,
      ].includes(status)
    ) {
      throw new AppError(
        400,
        "Invalid report status",
        COMMUNITY_PROGRAM_ERROR_CODES.INVALID_FRAUD_REPORT_STATUS
      );
    }
    const repository = this.dataSource.getRepository(InvoiceFraudReport);
    const report = await repository.findOneBy({ id });
    if (!report) {
      throw new AppError(
        404,
        "Fraud report not found",
        COMMUNITY_PROGRAM_ERROR_CODES.FRAUD_REPORT_NOT_FOUND
      );
    }
    report.status = status;
    report.reviewNote = reviewNote?.trim().slice(0, 4000) ?? null;
    return repository.save(report);
  }

  async registerReferral(referrerWallet: string, refereeWallet: string) {
    if (!referrerWallet || !refereeWallet || referrerWallet === refereeWallet) {
      throw new AppError(
        400,
        "A referral must link two different wallets",
        COMMUNITY_PROGRAM_ERROR_CODES.INVALID_REFERRAL
      );
    }
    const repository = this.dataSource.getRepository(Referral);
    const existing = await repository.findOne({ where: { refereeWallet } });
    if (existing) return existing;
    return repository.save(
      repository.create({
        referrerWallet,
        refereeWallet,
        earnedAmount: "0",
        claimedAmount: "0",
      })
    );
  }

  async referralStats(wallet: string) {
    const referrals = await this.dataSource.getRepository(Referral).find({
      where: { referrerWallet: wallet },
      order: { createdAt: "DESC" },
    });
    const earned = referrals.reduce((sum, row) => sum.plus(row.earnedAmount), new Decimal(0));
    const claimed = referrals.reduce((sum, row) => sum.plus(row.claimedAmount), new Decimal(0));
    return {
      totalReferees: referrals.length,
      earned: earned.toFixed(4),
      pending: earned.minus(claimed).toFixed(4),
      history: referrals,
    };
  }

  async buildReferralClaim(wallet: string) {
    const stats = await this.referralStats(wallet);
    if (new Decimal(stats.pending).lte(0)) {
      throw new AppError(
        409,
        "No referral rewards are available to claim",
        COMMUNITY_PROGRAM_ERROR_CODES.NO_AVAILABLE_REFERRAL_REWARDS
      );
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
      throw new AppError(
        400,
        "A valid wallet and email are required",
        COMMUNITY_PROGRAM_ERROR_CODES.INVALID_WAITLIST_REGISTRATION
      );
    }
    const repository = this.dataSource.getRepository(WaitlistEntry);
    const existing = await repository.findOne({ where: { wallet } });
    if (existing) return this.waitlistView(existing);
    const entry = await repository.save(
      repository.create({
        wallet,
        email,
        referralCode: `${wallet.slice(0, 8)}-${Date.now()}`,
        referralCount: 0,
        status: "pending",
      })
    );
    if (referralCode) await repository.increment({ referralCode }, "referralCount", 1);
    return this.waitlistView(entry);
  }

  async waitlistView(entry: WaitlistEntry) {
    const ahead = await this.dataSource
      .getRepository(WaitlistEntry)
      .count({ where: { status: "pending" } });
    return {
      wallet: entry.wallet,
      position: Math.max(1, ahead - entry.referralCount),
      referralCount: entry.referralCount,
      referralCode: entry.referralCode,
      status: entry.status,
    };
  }

  async approveWaitlist(wallet: string) {
    const repository = this.dataSource.getRepository(WaitlistEntry);
    const entry = await repository.findOne({ where: { wallet } });
    if (!entry) {
      throw new AppError(
        404,
        "Waitlist entry not found",
        COMMUNITY_PROGRAM_ERROR_CODES.WAITLIST_ENTRY_NOT_FOUND
      );
    }
    entry.status = "approved";
    return repository.save(entry);
  }
}
