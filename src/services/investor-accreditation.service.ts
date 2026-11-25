import type { DataSource, Repository } from "typeorm";
import type Redis from "ioredis";
import {
  InvestorAccreditation,
  AccreditationStatus,
  AccreditationTier,
  ACCREDITATION_LIMITS,
} from "../models/InvestorAccreditation.model";
import { Invoice } from "../models/Invoice.model";
import { SecondaryListing } from "../models/SecondaryListing.model";
import { logger } from "../observability/logger";
import Decimal from "decimal.js";

export const ACCREDITATION_CACHE_PREFIX = "accreditation:status:";
/** Upper bound on how long a cached status may live, so out-of-band DB edits
 * are eventually picked up even for accreditations expiring far in the future. */
export const ACCREDITATION_CACHE_MAX_TTL_SECONDS = 24 * 60 * 60;

export interface AccreditationExpiryStatus {
  expired: boolean;
  /** ISO timestamp of the expiry, or null when the accreditation never expires. */
  expiresAt: string | null;
  status: AccreditationStatus | null;
}

interface CachedAccreditation {
  expiryDate: string | null;
  status: AccreditationStatus | null;
}

export interface RenewAccreditationInput {
  documentReference: string;
}

export function accreditationCacheKey(walletAddress: string): string {
  return `${ACCREDITATION_CACHE_PREFIX}${walletAddress}`;
}

/**
 * TTL synced to the accreditation's expiry: the cache entry disappears the
 * moment the accreditation lapses, so the next read goes back to the DB.
 * Entries that are already expired (or never expire) use the max TTL; any
 * renewal or admin update invalidates them explicitly.
 */
export function computeAccreditationCacheTtl(expiryDate: Date | null, now: Date): number {
  if (!expiryDate) return ACCREDITATION_CACHE_MAX_TTL_SECONDS;
  const secondsUntilExpiry = Math.ceil((expiryDate.getTime() - now.getTime()) / 1000);
  if (secondsUntilExpiry <= 0) return ACCREDITATION_CACHE_MAX_TTL_SECONDS;
  return Math.min(secondsUntilExpiry, ACCREDITATION_CACHE_MAX_TTL_SECONDS);
}

export class InvestorAccreditationService {
  constructor(
    private accreditationRepo: Repository<InvestorAccreditation>,
    private invoiceRepo: Repository<Invoice>,
    private readonly listingRepo?: Repository<SecondaryListing>,
    private readonly redisClient?: Redis,
    private readonly now: () => Date = () => new Date()
  ) {}

  async getAccreditation(walletAddress: string): Promise<InvestorAccreditation> {
    let accreditation = await this.accreditationRepo.findOne({
      where: { walletAddress },
    });

    if (!accreditation) {
      accreditation = this.accreditationRepo.create({
        walletAddress,
        tier: AccreditationTier.UNACCREDITED,
      });
      accreditation = await this.accreditationRepo.save(accreditation);
    }

    return accreditation;
  }

  async updateAccreditation(
    walletAddress: string,
    tier: AccreditationTier,
    verificationSource?: string,
    expiryDate?: Date | null
  ): Promise<InvestorAccreditation> {
    let accreditation = await this.accreditationRepo.findOne({
      where: { walletAddress },
    });

    if (!accreditation) {
      accreditation = this.accreditationRepo.create({
        walletAddress,
        tier,
        status: AccreditationStatus.ACTIVE,
        verificationDate: this.now(),
        verificationSource: verificationSource || null,
        expiryDate: expiryDate ?? null,
      });
    } else {
      accreditation.tier = tier;
      accreditation.status = AccreditationStatus.ACTIVE;
      accreditation.verificationDate = this.now();
      accreditation.verificationSource = verificationSource || null;
      if (expiryDate !== undefined) {
        accreditation.expiryDate = expiryDate;
      }
    }

    const saved = await this.accreditationRepo.save(accreditation);
    await this.invalidateCache(walletAddress);
    return saved;
  }

  /**
   * Records a renewal document submission (issue #780). The accreditation
   * moves to `pending_review`; its expiry is unchanged until an admin approves
   * the renewal, so an expired wallet stays blocked until then.
   */
  async renewAccreditation(
    walletAddress: string,
    { documentReference }: RenewAccreditationInput
  ): Promise<InvestorAccreditation> {
    let accreditation = await this.accreditationRepo.findOne({
      where: { walletAddress },
    });

    if (!accreditation) {
      accreditation = this.accreditationRepo.create({
        walletAddress,
        tier: AccreditationTier.UNACCREDITED,
      });
    }

    accreditation.documentReference = documentReference;
    accreditation.renewalSubmittedAt = this.now();
    accreditation.status = AccreditationStatus.PENDING_REVIEW;

    const saved = await this.accreditationRepo.save(accreditation);
    await this.invalidateCache(walletAddress);
    return saved;
  }

  /** Expiry status for the gating middleware, read through the Redis cache. */
  async getExpiryStatus(walletAddress: string): Promise<AccreditationExpiryStatus> {
    const cached = await this.readCache(walletAddress);
    const record = cached ?? (await this.loadAndCache(walletAddress));
    const expiryDate = record.expiryDate ? new Date(record.expiryDate) : null;

    return {
      expired: expiryDate !== null && expiryDate.getTime() <= this.now().getTime(),
      expiresAt: expiryDate ? expiryDate.toISOString() : null,
      status: record.status,
    };
  }

  /** Null when the invoice does not exist. */
  async invoiceRequiresAccreditation(invoiceId: string): Promise<boolean | null> {
    const invoice = await this.invoiceRepo.findOne({
      where: { id: invoiceId },
      select: { id: true, requiresAccreditation: true },
    });
    if (!invoice) return null;
    return invoice.requiresAccreditation !== false;
  }

  async getInvoiceIdForListing(listingId: string): Promise<string | null> {
    if (!this.listingRepo) return null;
    const listing = await this.listingRepo.findOne({
      where: { id: listingId },
      select: { id: true, invoiceId: true },
    });
    return listing?.invoiceId ?? null;
  }

  async invalidateCache(walletAddress: string): Promise<void> {
    if (!this.redisClient) return;
    try {
      await this.redisClient.del(accreditationCacheKey(walletAddress));
    } catch (error) {
      logger.warn("Failed to invalidate accreditation cache", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Evaluates whether a wallet is eligible to make a commitment of
   * `proposedAmount` on the given invoice.
   *
   * The accreditation tier limit is a per-commitment ceiling (not an aggregate
   * exposure limit), denominated in the same currency as the investment amount.
   * Comparing the proposed commitment — rather than the invoice face value —
   * lets a small fractional investor pass a check that the full invoice would
   * fail, which is the correct policy (issue #744).
   */
  async checkEligibility(
    walletAddress: string,
    invoiceId: string,
    proposedAmount: Decimal | number | string
  ): Promise<{ eligible: boolean; reason?: string }> {
    const accreditation = await this.getAccreditation(walletAddress);
    const invoice = await this.invoiceRepo.findOne({ where: { id: invoiceId } });

    if (!invoice) {
      return { eligible: false, reason: "Invoice not found" };
    }

    const investmentLimit = new Decimal(ACCREDITATION_LIMITS[accreditation.tier]);
    const commitment = new Decimal(proposedAmount);

    if (!commitment.isFinite() || commitment.lte(0)) {
      return { eligible: false, reason: "Proposed commitment amount must be a positive number" };
    }

    if (commitment.greaterThan(investmentLimit)) {
      return {
        eligible: false,
        reason: `Proposed commitment of ${commitment.toFixed(4)} exceeds the ${accreditation.tier} tier per-commitment limit of ${investmentLimit.toFixed(0)}`,
      };
    }

    return { eligible: true };
  }

  getInvestmentLimit(tier: AccreditationTier): number {
    return ACCREDITATION_LIMITS[tier];
  }

  private async readCache(walletAddress: string): Promise<CachedAccreditation | null> {
    if (!this.redisClient) return null;
    try {
      const raw = await this.redisClient.get(accreditationCacheKey(walletAddress));
      return raw ? (JSON.parse(raw) as CachedAccreditation) : null;
    } catch (error) {
      // A cache outage must not weaken the check: fall back to the DB.
      logger.warn("Failed to read accreditation cache", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async loadAndCache(walletAddress: string): Promise<CachedAccreditation> {
    const accreditation = await this.accreditationRepo.findOne({
      where: { walletAddress },
    });
    const expiryDate = accreditation?.expiryDate ? new Date(accreditation.expiryDate) : null;
    const record: CachedAccreditation = {
      expiryDate: expiryDate ? expiryDate.toISOString() : null,
      status: accreditation?.status ?? null,
    };

    if (this.redisClient) {
      try {
        await this.redisClient.set(
          accreditationCacheKey(walletAddress),
          JSON.stringify(record),
          "EX",
          computeAccreditationCacheTtl(expiryDate, this.now())
        );
      } catch (error) {
        logger.warn("Failed to write accreditation cache", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return record;
  }
}

export function createInvestorAccreditationService(
  dataSource: DataSource,
  redisClient?: Redis
): InvestorAccreditationService {
  return new InvestorAccreditationService(
    dataSource.getRepository(InvestorAccreditation),
    dataSource.getRepository(Invoice),
    dataSource.getRepository(SecondaryListing),
    redisClient
  );
}
