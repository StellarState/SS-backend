import type { DataSource } from "typeorm";

import { ReferralEarning } from "../models/ReferralEarning.model";
import { logger as globalLogger } from "../observability/logger";
import type { AppLogger } from "../observability/logger";
import type { DecodedSorobanEvent } from "../types/soroban.types";
import { AppError } from "../utils/http-error";
import {
  normalizeTopic,
  readEventString,
  type ContractEventHandler,
} from "./contract-event-bus.service";
import type { ReferralBalanceReader } from "./stellar/soroban-referral-reader";

export const REFERRAL_REWARD_EVENTS = {
  referralRewardPaid: "referral_reward_paid",
  referralRewardPaidCamel: "referralrewardpaid",
} as const;

const AMOUNT_SCALE = 4;
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

export interface RecordReferralRewardInput {
  eventId: string | null;
  referrerWallet: string;
  referredWallet: string;
  amount: string;
  txHash: string | null;
  ledgerSequence: string | null;
  earnedAt: Date;
}

export interface ReferralStatsTotals {
  referredCount: number;
  totalEarned: string;
}

export interface ListReferralEarningsOptions {
  limit: number;
  cursor?: { earnedAt: Date; id: string } | null;
  from?: Date | null;
  to?: Date | null;
}

export interface ReferralEarningsRepositoryContract {
  recordReferralReward(input: RecordReferralRewardInput): Promise<boolean>;
  getStatsByWallet(wallet: string): Promise<ReferralStatsTotals>;
  listEarnings(
    wallet: string,
    options: ListReferralEarningsOptions
  ): Promise<ReferralEarning[]>;
}

export interface ReferralStatsView {
  wallet: string;
  referred_count: number;
  total_earned: string;
  unclaimed_balance: string;
}

export interface ReferralEarningItemView {
  id: string;
  referred_wallet: string;
  amount: string;
  date: string;
  tx_hash: string | null;
  ledger_sequence: string | null;
}

export interface ReferralEarningsPage {
  items: ReferralEarningItemView[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ReferralEarningsServiceDependencies {
  referralEarningsRepository: ReferralEarningsRepositoryContract;
  balanceReader?: ReferralBalanceReader;
  now?: () => Date;
  logger?: AppLogger;
}

function formatAmount(raw: string | number): string {
  const numeric = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid numeric amount: ${String(raw)}`);
  }
  return numeric.toFixed(AMOUNT_SCALE);
}

function encodeCursor(earnedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ earnedAt: earnedAt.toISOString(), id }), "utf8").toString(
    "base64url"
  );
}

function decodeCursor(raw: string): { earnedAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      earnedAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.earnedAt !== "string" || typeof parsed.id !== "string" || !parsed.id) {
      throw new Error("Invalid cursor fields");
    }
    const earnedAt = new Date(parsed.earnedAt);
    if (Number.isNaN(earnedAt.getTime())) {
      throw new Error("Invalid cursor timestamp");
    }
    return { earnedAt, id: parsed.id };
  } catch {
    throw new AppError(400, "Invalid pagination cursor.", "INVALID_CURSOR");
  }
}

function parseEventDate(event: DecodedSorobanEvent, fallback: Date): Date {
  const data =
    event.data && typeof event.data === "object" && !Array.isArray(event.data)
      ? (event.data as Record<string, unknown>)
      : null;

  const candidate =
    data?.paid_at ??
    data?.earned_at ??
    data?.timestamp ??
    event.ledgerClosedAt;

  if (candidate instanceof Date && !Number.isNaN(candidate.getTime())) {
    return candidate;
  }
  if (typeof candidate === "string" && candidate.trim()) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    const ms = candidate < 1e12 ? candidate * 1000 : candidate;
    const parsed = new Date(ms);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fallback;
}

export function createReferralEarningsRepository(
  dataSource: DataSource
): ReferralEarningsRepositoryContract {
  const repo = dataSource.getRepository(ReferralEarning);

  return {
    async recordReferralReward(input: RecordReferralRewardInput): Promise<boolean> {
      if (input.eventId) {
        const existing = await repo.findOne({ where: { eventId: input.eventId } });
        if (existing) {
          return false;
        }
      }

      const entity = repo.create({
        eventId: input.eventId,
        referrerWallet: input.referrerWallet,
        referredWallet: input.referredWallet,
        amount: input.amount,
        txHash: input.txHash,
        ledgerSequence: input.ledgerSequence,
        earnedAt: input.earnedAt,
      });

      await repo.save(entity);
      return true;
    },

    async getStatsByWallet(wallet: string): Promise<ReferralStatsTotals> {
      const row = await repo
        .createQueryBuilder("e")
        .select("COUNT(DISTINCT e.referred_wallet)", "referredCount")
        .addSelect("COALESCE(SUM(e.amount), 0)", "totalEarned")
        .where("e.referrer_wallet = :wallet", { wallet })
        .getRawOne<{ referredCount?: string; totalEarned?: string }>();

      return {
        referredCount: Number(row?.referredCount ?? 0),
        totalEarned: formatAmount(row?.totalEarned ?? "0"),
      };
    },

    async listEarnings(
      wallet: string,
      options: ListReferralEarningsOptions
    ): Promise<ReferralEarning[]> {
      const qb = repo
        .createQueryBuilder("e")
        .where("e.referrer_wallet = :wallet", { wallet });

      if (options.from) {
        qb.andWhere("e.earned_at >= :from", { from: options.from });
      }

      if (options.to) {
        qb.andWhere("e.earned_at <= :to", { to: options.to });
      }

      if (options.cursor) {
        qb.andWhere(
          "(e.earned_at < :cursorEarnedAt OR (e.earned_at = :cursorEarnedAt AND e.id < :cursorId))",
          {
            cursorEarnedAt: options.cursor.earnedAt,
            cursorId: options.cursor.id,
          }
        );
      }

      return qb
        .orderBy("e.earned_at", "DESC")
        .addOrderBy("e.id", "DESC")
        .take(options.limit)
        .getMany();
    },
  };
}

/**
 * Indexes `ReferralRewardPaid` contract events into `referral_earnings` and
 * serves referral stats (with live on-chain unclaimed balance) and
 * cursor-paginated, date-filterable referral earnings history.
 */
export class ReferralEarningsService implements ContractEventHandler {
  private readonly repository: ReferralEarningsRepositoryContract;
  private readonly balanceReader?: ReferralBalanceReader;
  private readonly now: () => Date;
  private readonly logger: AppLogger;

  constructor({
    referralEarningsRepository,
    balanceReader,
    now = () => new Date(),
    logger = globalLogger,
  }: ReferralEarningsServiceDependencies) {
    this.repository = referralEarningsRepository;
    this.balanceReader = balanceReader;
    this.now = now;
    this.logger = logger;
  }

  topics(): string[] {
    return [
      REFERRAL_REWARD_EVENTS.referralRewardPaid,
      REFERRAL_REWARD_EVENTS.referralRewardPaidCamel,
    ];
  }

  async handle(event: DecodedSorobanEvent): Promise<void> {
    const topic = normalizeTopic(event.topic);
    if (
      topic !== REFERRAL_REWARD_EVENTS.referralRewardPaid &&
      topic !== REFERRAL_REWARD_EVENTS.referralRewardPaidCamel
    ) {
      return;
    }

    const referrerWallet = readEventString(
      event,
      ["referrer_wallet", "referrerWallet", "referrer", "investor_wallet", "investor", "wallet"],
      1
    );
    const referredWallet = readEventString(
      event,
      ["referred_wallet", "referredWallet", "referred", "referee_wallet", "referee"],
      2
    );
    const rawAmount = readEventString(
      event,
      ["amount", "reward_amount", "rewardAmount", "reward"],
      3
    );

    if (!referrerWallet || !referredWallet || !rawAmount) {
      this.logger.warn("Skipping malformed ReferralRewardPaid event", {
        eventId: event.id,
        txHash: event.txHash,
        ledger: event.ledger,
      });
      return;
    }

    let formattedAmount: string;
    try {
      const parsed = Number(rawAmount);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error("Amount must be a non-negative finite number");
      }
      formattedAmount = parsed.toFixed(AMOUNT_SCALE);
    } catch {
      this.logger.warn("Skipping ReferralRewardPaid event with invalid amount", {
        eventId: event.id,
        rawAmount,
      });
      return;
    }

    const earnedAt = parseEventDate(event, this.now());

    await this.repository.recordReferralReward({
      eventId: event.id || null,
      referrerWallet,
      referredWallet,
      amount: formattedAmount,
      txHash: event.txHash || null,
      ledgerSequence: event.ledger !== undefined ? String(event.ledger) : null,
      earnedAt,
    });
  }

  async getStats(wallet: string): Promise<ReferralStatsView> {
    const normalizedWallet = wallet.trim();
    if (!normalizedWallet) {
      throw new AppError(400, "Wallet address is required.", "INVALID_WALLET");
    }

    const [totals, liveUnclaimed] = await Promise.all([
      this.repository.getStatsByWallet(normalizedWallet),
      this.balanceReader
        ? this.balanceReader.getUnclaimedBalance(normalizedWallet)
        : Promise.resolve("0"),
    ]);

    return {
      wallet: normalizedWallet,
      referred_count: totals.referredCount,
      total_earned: formatAmount(totals.totalEarned),
      unclaimed_balance: formatAmount(liveUnclaimed),
    };
  }

  async getEarnings(
    wallet: string,
    options: {
      limit?: number;
      cursor?: string | null;
      from?: Date | null;
      to?: Date | null;
    } = {}
  ): Promise<ReferralEarningsPage> {
    const normalizedWallet = wallet.trim();
    if (!normalizedWallet) {
      throw new AppError(400, "Wallet address is required.", "INVALID_WALLET");
    }

    if (options.from && options.to && options.from.getTime() > options.to.getTime()) {
      throw new AppError(
        400,
        "'from' date must be earlier than or equal to 'to' date.",
        "INVALID_DATE_RANGE"
      );
    }

    const limit = Math.min(
      Math.max(1, options.limit ?? DEFAULT_PAGE_LIMIT),
      MAX_PAGE_LIMIT
    );
    const decodedCursor = options.cursor ? decodeCursor(options.cursor) : null;

    const rows = await this.repository.listEarnings(normalizedWallet, {
      limit: limit + 1,
      cursor: decodedCursor,
      from: options.from ?? null,
      to: options.to ?? null,
    });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow ? encodeCursor(lastRow.earnedAt, lastRow.id) : null;

    return {
      items: pageRows.map((row) => ({
        id: row.id,
        referred_wallet: row.referredWallet,
        amount: formatAmount(row.amount),
        date: row.earnedAt.toISOString(),
        tx_hash: row.txHash,
        ledger_sequence: row.ledgerSequence,
      })),
      hasMore,
      nextCursor,
    };
  }
}

export function createReferralEarningsService(
  dependencies: ReferralEarningsServiceDependencies
): ReferralEarningsService {
  return new ReferralEarningsService(dependencies);
}
