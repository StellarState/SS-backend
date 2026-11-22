import { DataSource, EntityManager, In } from "typeorm";
import { Decimal } from "decimal.js";
import { SecondaryListing } from "../models/SecondaryListing.model";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { Transaction } from "../models/Transaction.model";
import { SecondaryTrade } from "../models/SecondaryTrade.model";
import { User } from "../models/User.model";
import { SettlementIntent, SettlementIntentStatus } from "../models/SettlementIntent.model";
import {
  ListingStatus,
  InvoiceStatus,
  InvestmentStatus,
  TransactionType,
  TransactionStatus,
  NotificationType,
} from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { logger } from "../observability/logger";
import { isPastDueDate } from "../utils/date.utils";
import type { NotificationService } from "./notification.service";
import type { FeeScheduleService } from "./fee-schedule.service";
import type { TransitionEffect } from "../lib/invoice-state-machine";

export interface CreateListingInput {
  invoiceId: string;
  sellerWallet: string;
  sellerId?: string;
  quantity: string | number;
  pricePerFraction: string | number;
  expiresAt?: Date;
}

export interface ListingFilters {
  invoiceId?: string;
  sellerWallet?: string;
  status?: ListingStatus;
  minPrice?: number;
  maxPrice?: number;
  sortBy?: "price" | "expires_at" | "created_at";
  sortOrder?: "ASC" | "DESC";
}

export interface PaginationOptions {
  page: number;
  limit: number;
}

export interface BuyListingInput {
  listingId: string;
  buyerWallet: string;
  buyerId: string;
  quantity?: string | number;
}

export interface ListingResult {
  id: string;
  version: number;
  invoiceId: string;
  sellerWallet: string;
  quantity: string;
  pricePerFraction: string;
  totalPrice: string;
  status: ListingStatus;
  expiresAt: Date;
  createdAt: Date;
}

export interface ListingDetailResult extends ListingResult {
  invoice: {
    id: string;
    invoiceNumber: string;
    customerName: string;
    amount: string;
    status: InvoiceStatus;
    dueDate: Date;
  };
}

export interface BuyListingResult {
  listingId: string;
  tradeId: string | null;
  buyerWallet: string;
  quantity: string;
  pricePerFraction: string;
  /** Gross purchase amount paid by the buyer. */
  totalPrice: string;
  platformFeeBps: number;
  platformFee: string;
  royaltyBps: number;
  royalty: string;
  royaltyRecipientWallet: string | null;
  sellerProceeds: string;
  listingStatus: ListingStatus;
  remainingQuantity: string;
}

export interface SecondaryMarketOptions {
  /** Source of the platform's secondary market fee. Without it no fee is charged. */
  feeSchedule?: Pick<FeeScheduleService, "getFeeRate">;
  now?: () => Date;
}

/** Fee charged when a fee schedule is wired but none is active (matches the schema default). */
export const DEFAULT_SECONDARY_MARKET_FEE_BPS = 150;
const BPS_DENOMINATOR = 10_000;
const MAX_FRACTION_DECIMALS = 4;

/** Allowed listing status transitions (issue #783): only active listings move. */
const LISTING_TRANSITIONS: Record<ListingStatus, readonly ListingStatus[]> = {
  [ListingStatus.ACTIVE]: [ListingStatus.SOLD, ListingStatus.CANCELLED, ListingStatus.EXPIRED],
  [ListingStatus.SOLD]: [],
  [ListingStatus.CANCELLED]: [],
  [ListingStatus.EXPIRED]: [],
};

export function transitionListing(listing: SecondaryListing, to: ListingStatus): void {
  if (!LISTING_TRANSITIONS[listing.status]?.includes(to)) {
    throw new ServiceError(
      "INVALID_LISTING_TRANSITION",
      `Listing cannot move from ${listing.status} to ${to}`,
      409
    );
  }
  listing.status = to;
}

function isListingExpired(listing: SecondaryListing, now: Date): boolean {
  if (typeof listing.isExpired === "function") return listing.isExpired(now);
  return new Date(listing.expiresAt).getTime() < now.getTime();
}

/** Parses a positive decimal with at most 4 places; throws a 400 ServiceError otherwise. */
function parsePositiveAmount(value: unknown, code: string, label: string): Decimal {
  let parsed: Decimal;
  try {
    if (typeof value !== "string" && typeof value !== "number") throw new Error("type");
    parsed = new Decimal(value);
  } catch {
    throw new ServiceError(code, `${label} must be a positive number`, 400);
  }
  if (!parsed.isFinite() || parsed.lte(0)) {
    throw new ServiceError(code, `${label} must be greater than zero`, 400);
  }
  if (parsed.decimalPlaces() > MAX_FRACTION_DECIMALS) {
    throw new ServiceError(
      code,
      `${label} supports at most ${MAX_FRACTION_DECIMALS} decimal places`,
      400
    );
  }
  return parsed;
}

/** Basis-point share of an amount, rounded half-up to 4 decimal places. */
function bpsOf(amount: Decimal, bps: number): Decimal {
  return amount.times(bps).dividedBy(BPS_DENOMINATOR).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

export class SecondaryMarketService {
  private readonly now: () => Date;

  constructor(
    private readonly dataSource: DataSource,
    private readonly notificationService?: NotificationService,
    private readonly options: SecondaryMarketOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Create a new secondary market listing for invoice fractions.
   * Validates quantity against seller's available holding balance.
   */
  async createListing(input: CreateListingInput): Promise<SecondaryListing> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const { invoiceId, sellerWallet, sellerId, quantity, pricePerFraction, expiresAt } = input;

      // Validate input
      const quantityDecimal = parsePositiveAmount(quantity, "INVALID_QUANTITY", "Quantity");
      const priceDecimal = parsePositiveAmount(
        pricePerFraction,
        "INVALID_PRICE",
        "Price per fraction"
      );

      if (expiresAt && new Date(expiresAt) <= new Date()) {
        throw new ServiceError("INVALID_EXPIRY", "Expiry date must be in the future", 400);
      }

      // Get invoice
      const invoice = await manager.findOne(Invoice, {
        where: { id: invoiceId },
        lock: { mode: "pessimistic_write" },
      });
      if (!invoice) {
        throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
      }

      // Check if invoice has matured (reject with 422)
      const isMatured =
        invoice.status === InvoiceStatus.SETTLED ||
        invoice.status === InvoiceStatus.FAILED ||
        (invoice.dueDate
          ? isPastDueDate(invoice.dueDate) || new Date(invoice.dueDate).getTime() <= Date.now()
          : false);

      if (isMatured) {
        throw new ServiceError(
          "INVOICE_MATURED",
          "Cannot list shares on an invoice that is past maturity",
          422
        );
      }

      if (invoice.status !== InvoiceStatus.FUNDED) {
        throw new ServiceError(
          "INVALID_INVOICE_STATUS",
          "Only funded invoices can be listed on secondary market",
          400
        );
      }

      // Lock-up: holdings cannot be listed until the invoice's lock-up ends.
      if (invoice.lockUpExpiry) {
        const lockUpExpiry = new Date(invoice.lockUpExpiry);
        const remainingMs = lockUpExpiry.getTime() - this.now().getTime();
        if (remainingMs > 0) {
          const remainingSeconds = Math.ceil(remainingMs / 1000);
          throw new ServiceError(
            "LOCK_UP_ACTIVE",
            `Holdings in this invoice are locked up for another ${remainingSeconds} seconds`,
            422,
            {
              lock_up_expiry: lockUpExpiry.toISOString(),
              lock_up_remaining_seconds: remainingSeconds,
            }
          );
        }
      }
      const settlementIntent = await manager.findOne(SettlementIntent, {
        where: {
          invoiceId,
          status: In([
            SettlementIntentStatus.PREPARED,
            SettlementIntentStatus.SUBMITTING,
            SettlementIntentStatus.DISTRIBUTED,
          ]),
        },
      });
      if (settlementIntent) {
        throw new ServiceError(
          "SETTLEMENT_IN_PROGRESS",
          "Invoice settlement is in progress; holdings cannot be listed",
          409
        );
      }

      const effectiveExpiresAt = expiresAt
        ? new Date(expiresAt)
        : invoice.dueDate
          ? new Date(invoice.dueDate)
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      if (effectiveExpiresAt <= new Date()) {
        throw new ServiceError("INVALID_EXPIRY", "Expiry date must be in the future", 400);
      }

      // Get seller's investments in this invoice
      const investments = await manager.find(Investment, {
        where: [
          ...(sellerWallet
            ? [{ invoiceId, investorWallet: sellerWallet, status: InvestmentStatus.CONFIRMED }]
            : []),
          ...(sellerId
            ? [{ invoiceId, investorId: sellerId, status: InvestmentStatus.CONFIRMED }]
            : []),
        ],
        lock: { mode: "pessimistic_write" },
      });

      if (investments.length === 0) {
        throw new ServiceError(
          "NO_HOLDINGS",
          "Seller has no confirmed investments in this invoice",
          400
        );
      }

      // Calculate total holdings
      const totalHoldings = investments.reduce(
        (sum, inv) => sum.plus(new Decimal(inv.investmentAmount)),
        new Decimal(0)
      );

      // Check active listings by this seller for this invoice to prevent double-listing
      const activeListingsWhere =
        sellerWallet && sellerId
          ? [
              { invoiceId, sellerWallet, status: ListingStatus.ACTIVE },
              { invoiceId, sellerId, status: ListingStatus.ACTIVE },
            ]
          : {
              invoiceId,
              ...(sellerWallet ? { sellerWallet } : {}),
              ...(sellerId ? { sellerId } : {}),
              status: ListingStatus.ACTIVE,
            };

      const activeListings = await manager.find(SecondaryListing, {
        where: activeListingsWhere,
      });

      const currentlyListed = activeListings
        .filter((l) => {
          if (typeof l.isExpired === "function") {
            return !l.isExpired();
          }
          return !l.expiresAt || new Date(l.expiresAt).getTime() >= Date.now();
        })
        .reduce((sum, l) => sum.plus(new Decimal(l.quantity)), new Decimal(0));

      const availableHoldings = totalHoldings.minus(currentlyListed);

      // Check if quantity exceeds available holdings
      if (quantityDecimal.gt(availableHoldings)) {
        throw new ServiceError(
          "INSUFFICIENT_HOLDINGS",
          `Requested quantity ${quantity} exceeds available holdings ${availableHoldings.toFixed(4)}`,
          400
        );
      }

      // Calculate total price
      const totalPrice = quantityDecimal.times(priceDecimal);

      // Create listing
      const listing = manager.create(SecondaryListing, {
        invoiceId,
        sellerWallet,
        sellerId: sellerId || null,
        quantity: quantityDecimal.toFixed(4),
        pricePerFraction: priceDecimal.toFixed(4),
        totalPrice: totalPrice.toFixed(4),
        status: ListingStatus.ACTIVE,
        expiresAt: effectiveExpiresAt,
      });

      const saved = await manager.save(listing);

      logger.info("secondary.listing.created", {
        listing_id: saved.id,
        invoice_id: invoiceId,
        seller_wallet: sellerWallet,
        quantity: quantity,
        price_per_fraction: pricePerFraction,
      });

      return saved;
    });
  }

  /**
   * Get active listings with filters and pagination.
   * Expired listings are excluded from results.
   */
  async getListings(
    filters: ListingFilters = {},
    pagination: PaginationOptions = { page: 1, limit: 20 }
  ): Promise<{
    data: ListingResult[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const repository = this.dataSource.getRepository(SecondaryListing);
    const queryBuilder = repository
      .createQueryBuilder("listing")
      .leftJoinAndSelect("listing.invoice", "invoice")
      .where("listing.deleted_at IS NULL")
      .andWhere("listing.status = :status", { status: ListingStatus.ACTIVE })
      .andWhere("listing.expires_at > :now", { now: new Date() });

    // Apply filters
    if (filters.invoiceId) {
      queryBuilder.andWhere("listing.invoice_id = :invoiceId", { invoiceId: filters.invoiceId });
    }

    if (filters.sellerWallet) {
      queryBuilder.andWhere("listing.seller_wallet = :sellerWallet", {
        sellerWallet: filters.sellerWallet,
      });
    }

    if (filters.minPrice !== undefined) {
      queryBuilder.andWhere("CAST(listing.price_per_fraction AS NUMERIC) >= :minPrice", {
        minPrice: filters.minPrice,
      });
    }

    if (filters.maxPrice !== undefined) {
      queryBuilder.andWhere("CAST(listing.price_per_fraction AS NUMERIC) <= :maxPrice", {
        maxPrice: filters.maxPrice,
      });
    }

    // Apply sorting
    const sortColumn = this.getSortColumn(filters.sortBy || "created_at");
    queryBuilder.orderBy(sortColumn, filters.sortOrder || "DESC");
    queryBuilder.addOrderBy("listing.id", "ASC");

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const offset = (pagination.page - 1) * pagination.limit;
    queryBuilder.skip(offset).take(pagination.limit);

    const listings = await queryBuilder.getMany();

    const data: ListingResult[] = listings.map((listing) => ({
      id: listing.id,
      version: listing.version,
      invoiceId: listing.invoiceId,
      sellerWallet: listing.sellerWallet,
      quantity: listing.quantity,
      pricePerFraction: listing.pricePerFraction,
      totalPrice: listing.totalPrice,
      status: listing.status,
      expiresAt: listing.expiresAt,
      createdAt: listing.createdAt,
    }));

    return {
      data,
      meta: {
        total,
        page: pagination.page,
        limit: pagination.limit,
        totalPages: Math.ceil(total / pagination.limit),
      },
    };
  }

  /**
   * Get a specific listing by ID with full details.
   */
  async getListingById(id: string): Promise<ListingDetailResult> {
    const repository = this.dataSource.getRepository(SecondaryListing);
    const listing = await repository.findOne({
      where: { id },
      relations: ["invoice"],
    });

    if (!listing) {
      throw new ServiceError("LISTING_NOT_FOUND", "Listing not found", 404);
    }

    return {
      id: listing.id,
      version: listing.version,
      invoiceId: listing.invoiceId,
      sellerWallet: listing.sellerWallet,
      quantity: listing.quantity,
      pricePerFraction: listing.pricePerFraction,
      totalPrice: listing.totalPrice,
      status: listing.status,
      expiresAt: listing.expiresAt,
      createdAt: listing.createdAt,
      invoice: {
        id: listing.invoice.id,
        invoiceNumber: listing.invoice.invoiceNumber,
        customerName: listing.invoice.customerName,
        amount: listing.invoice.amount,
        status: listing.invoice.status,
        dueDate: listing.invoice.dueDate,
      },
    };
  }

  /**
   * Execute a purchase of (part of) a listing (issue #783).
   *
   * In one transaction, with the listing, invoice and seller holdings locked
   * FOR UPDATE so concurrent buyers serialise and cannot double-sell:
   * - moves the fractions from the seller's holdings to the buyer's,
   * - splits the gross amount into platform fee, issuer royalty (when the
   *   invoice configures one) and seller proceeds,
   * - records the split in `secondary_trades` plus payment transactions,
   * - moves the listing to `sold` once nothing is left.
   * A listing found past its expiry is moved to `expired` and rejected.
   */
  async buyListing(input: BuyListingInput): Promise<BuyListingResult> {
    const { listingId, buyerWallet, buyerId, quantity } = input;
    const requestedQuantity =
      quantity === undefined || quantity === null || quantity === ""
        ? null
        : parsePositiveAmount(quantity, "INVALID_QUANTITY", "Quantity");

    // Resolved before taking row locks so a slow fee lookup never holds them.
    const platformFeeBps = await this.resolvePlatformFeeBps();

    type Outcome =
      | { expired: true }
      | {
          expired: false;
          result: BuyListingResult;
          soldNotification: { userId: string; data: Record<string, unknown> } | null;
        };

    const outcome = await this.dataSource.transaction(
      async (manager: EntityManager): Promise<Outcome> => {
        const now = this.now();
        const listing = await manager.findOne(SecondaryListing, {
          where: { id: listingId },
          lock: { mode: "pessimistic_write" },
        });

        if (!listing) {
          throw new ServiceError("LISTING_NOT_FOUND", "Listing not found", 404);
        }

        if (listing.status !== ListingStatus.ACTIVE) {
          throw new ServiceError("LISTING_NOT_ACTIVE", "Listing is not active", 400);
        }

        if (isListingExpired(listing, now)) {
          // Commit the expiry, then reject outside the transaction.
          transitionListing(listing, ListingStatus.EXPIRED);
          await manager.save(listing);
          return { expired: true };
        }

        if (
          listing.sellerWallet === buyerWallet ||
          (Boolean(listing.sellerId) && Boolean(buyerId) && listing.sellerId === buyerId)
        ) {
          throw new ServiceError("SELF_PURCHASE", "Cannot buy your own listing", 400);
        }

        const invoice = await manager.findOne(Invoice, {
          where: { id: listing.invoiceId },
          lock: { mode: "pessimistic_write" },
        });
        if (!invoice) {
          throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
        }
        if (invoice.status !== InvoiceStatus.FUNDED) {
          throw new ServiceError(
            "INVALID_INVOICE_STATUS",
            "Only funded invoices can be purchased on the secondary market",
            400
          );
        }
        const settlementIntent = await manager.findOne(SettlementIntent, {
          where: {
            invoiceId: invoice.id,
            status: In([
              SettlementIntentStatus.PREPARED,
              SettlementIntentStatus.SUBMITTING,
              SettlementIntentStatus.DISTRIBUTED,
            ]),
          },
        });
        if (settlementIntent) {
          throw new ServiceError(
            "SETTLEMENT_IN_PROGRESS",
            "Invoice settlement is in progress; holdings cannot be transferred",
            409
          );
        }

        const listedQuantity = new Decimal(listing.quantity);
        const buyQuantity = requestedQuantity ?? listedQuantity;

        // Over-purchase beyond listing quantity rejected with 409
        if (buyQuantity.gt(listedQuantity)) {
          throw new ServiceError(
            "OVER_PURCHASE",
            `Requested quantity ${buyQuantity.toFixed(4)} exceeds available ${listing.quantity}`,
            409
          );
        }

        // Seller holdings, locked so a concurrent sale cannot spend them twice.
        const sellerInvestments = await manager.find(Investment, {
          where: [
            ...(listing.sellerWallet
              ? [
                  {
                    invoiceId: listing.invoiceId,
                    investorWallet: listing.sellerWallet,
                    status: InvestmentStatus.CONFIRMED,
                  },
                ]
              : []),
            ...(listing.sellerId
              ? [
                  {
                    invoiceId: listing.invoiceId,
                    investorId: listing.sellerId,
                    status: InvestmentStatus.CONFIRMED,
                  },
                ]
              : []),
          ],
          lock: { mode: "pessimistic_write" },
        });
        const sellerHoldings = sellerInvestments.reduce(
          (sum, inv) => sum.plus(new Decimal(inv.investmentAmount)),
          new Decimal(0)
        );
        if (sellerHoldings.lt(buyQuantity)) {
          throw new ServiceError(
            "SELLER_HOLDINGS_INSUFFICIENT",
            "The seller no longer holds enough fractions to fill this purchase",
            409
          );
        }

        // ---- Amount split ----
        const pricePerFraction = new Decimal(listing.pricePerFraction);
        const grossAmount = buyQuantity
          .times(pricePerFraction)
          .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
        const royaltyBps = Math.max(0, Number(invoice.secondaryRoyaltyBps ?? 0));
        const royaltyRecipientWallet =
          royaltyBps > 0 ? await this.resolveIssuerWallet(manager, invoice) : null;
        const effectiveRoyaltyBps = royaltyRecipientWallet ? royaltyBps : 0;
        const platformFee = bpsOf(grossAmount, platformFeeBps);
        const royalty = bpsOf(grossAmount, effectiveRoyaltyBps);
        const sellerProceeds = grossAmount.minus(platformFee).minus(royalty);
        if (sellerProceeds.lt(0)) {
          throw new ServiceError(
            "INVALID_FEE_CONFIGURATION",
            "Platform fee and royalty exceed the purchase amount",
            500
          );
        }

        // Simulated Soroban transaction hash
        const transactionHash = `simulated_${now.getTime()}`;

        // ---- Listing state ----
        const remaining = listedQuantity.minus(buyQuantity);
        const soldOut = remaining.isZero();
        if (soldOut) {
          transitionListing(listing, ListingStatus.SOLD);
        } else {
          listing.quantity = remaining.toFixed(4);
          listing.totalPrice = remaining.times(pricePerFraction).toFixed(4);
        }
        await manager.save(listing);

        // ---- Fraction transfer: seller -> buyer ----
        let remainingToDeduct = new Decimal(buyQuantity);
        for (const inv of sellerInvestments) {
          if (remainingToDeduct.lte(0)) break;
          const currentInvAmount = new Decimal(inv.investmentAmount);
          if (currentInvAmount.lte(remainingToDeduct)) {
            inv.investmentAmount = "0.0000";
            remainingToDeduct = remainingToDeduct.minus(currentInvAmount);
          } else {
            inv.investmentAmount = currentInvAmount.minus(remainingToDeduct).toFixed(4);
            remainingToDeduct = new Decimal(0);
          }
          await manager.save(inv);
        }

        let buyerInvestment = await manager.findOne(Investment, {
          where: {
            invoiceId: listing.invoiceId,
            investorId: buyerId,
            status: InvestmentStatus.CONFIRMED,
          },
          lock: { mode: "pessimistic_write" },
        });

        if (buyerInvestment) {
          buyerInvestment.investmentAmount = new Decimal(buyerInvestment.investmentAmount)
            .plus(buyQuantity)
            .toFixed(4);
          if (buyerWallet && !buyerInvestment.investorWallet) {
            buyerInvestment.investorWallet = buyerWallet;
          }
          buyerInvestment = await manager.save(buyerInvestment);
        } else {
          buyerInvestment = await manager.save(
            manager.create(Investment, {
              invoiceId: listing.invoiceId,
              investorId: buyerId,
              investorWallet: buyerWallet,
              investmentAmount: buyQuantity.toFixed(4),
              expectedReturn: buyQuantity.toFixed(4),
              status: InvestmentStatus.CONFIRMED,
            })
          );
        }

        // ---- Settlement records ----
        const trade = await manager.save(
          manager.create(SecondaryTrade, {
            listingId: listing.id,
            invoiceId: listing.invoiceId,
            sellerWallet: listing.sellerWallet,
            sellerId: listing.sellerId ?? null,
            buyerWallet,
            buyerId,
            fractions: buyQuantity.toFixed(4),
            pricePerFraction: pricePerFraction.toFixed(4),
            grossAmount: grossAmount.toFixed(4),
            platformFeeBps,
            platformFeeAmount: platformFee.toFixed(4),
            royaltyBps: effectiveRoyaltyBps,
            royaltyAmount: royalty.toFixed(4),
            royaltyRecipientWallet,
            sellerProceeds: sellerProceeds.toFixed(4),
            transactionHash,
          })
        );

        await manager.save(
          manager.create(Transaction, {
            userId: buyerId,
            investmentId: buyerInvestment?.id ?? null,
            invoiceId: listing.invoiceId,
            type: TransactionType.PAYMENT,
            amount: grossAmount.toFixed(4),
            status: TransactionStatus.COMPLETED,
            stellarTxHash: transactionHash,
          })
        );
        if (listing.sellerId) {
          await manager.save(
            manager.create(Transaction, {
              userId: listing.sellerId,
              invoiceId: listing.invoiceId,
              type: TransactionType.PAYMENT,
              amount: sellerProceeds.toFixed(4),
              status: TransactionStatus.COMPLETED,
              stellarTxHash: transactionHash,
            })
          );
        }
        if (royalty.gt(0)) {
          await manager.save(
            manager.create(Transaction, {
              userId: invoice.sellerId,
              invoiceId: listing.invoiceId,
              type: TransactionType.PAYMENT,
              amount: royalty.toFixed(4),
              status: TransactionStatus.COMPLETED,
              stellarTxHash: transactionHash,
            })
          );
        }

        logger.info("secondary.listing.purchased", {
          listing_id: listingId,
          trade_id: trade?.id ?? null,
          buyer_wallet: buyerWallet,
          quantity: buyQuantity.toFixed(4),
          gross_amount: grossAmount.toFixed(4),
          platform_fee: platformFee.toFixed(4),
          royalty: royalty.toFixed(4),
          seller_proceeds: sellerProceeds.toFixed(4),
        });

        let soldNotification: { userId: string; data: Record<string, unknown> } | null = null;
        if (soldOut) {
          const userId = listing.sellerId ?? listing.sellerWallet;
          if (userId) {
            soldNotification = {
              userId,
              data: {
                listingId,
                buyerWallet,
                quantity: buyQuantity.toFixed(4),
                totalPrice: grossAmount.toFixed(4),
                sellerProceeds: sellerProceeds.toFixed(4),
              },
            };
          } else {
            logger.warn("secondary.notification.skipped", {
              listing_id: listingId,
              reason: "no_seller_identity",
            });
          }
        }

        return {
          expired: false,
          soldNotification,
          result: {
            listingId,
            tradeId: trade?.id ?? null,
            buyerWallet,
            quantity: buyQuantity.toFixed(4),
            pricePerFraction: pricePerFraction.toFixed(4),
            totalPrice: grossAmount.toFixed(4),
            platformFeeBps,
            platformFee: platformFee.toFixed(4),
            royaltyBps: effectiveRoyaltyBps,
            royalty: royalty.toFixed(4),
            royaltyRecipientWallet,
            sellerProceeds: sellerProceeds.toFixed(4),
            listingStatus: soldOut ? ListingStatus.SOLD : ListingStatus.ACTIVE,
            remainingQuantity: remaining.toFixed(4),
          },
        };
      }
    );

    if (outcome.expired) {
      throw new ServiceError("LISTING_EXPIRED", "Listing has expired", 400);
    }

    // Fire notification after transaction commits — never throw out of here
    if (outcome.soldNotification && this.notificationService) {
      try {
        await this.notificationService.createNotification(
          outcome.soldNotification.userId,
          NotificationType.SECONDARY_MARKET_SOLD,
          "Listing Sold",
          "Your listing for an invoice fraction has been fully purchased.",
          outcome.soldNotification.data
        );
      } catch (error) {
        logger.warn("secondary.notification.failed", { listing_id: listingId, error });
      }
    }

    return outcome.result;
  }

  /**
   * Moves active listings whose expiry has passed to `expired` (issue #783).
   * Returns the number of listings expired.
   */
  async expireStaleListings(): Promise<number> {
    const result = await this.dataSource
      .createQueryBuilder()
      .update(SecondaryListing)
      .set({ status: ListingStatus.EXPIRED })
      .where("status = :active", { active: ListingStatus.ACTIVE })
      .andWhere("expires_at <= :now", { now: this.now() })
      .andWhere("deleted_at IS NULL")
      .execute();
    const expired = result.affected ?? 0;
    if (expired > 0) {
      logger.info("secondary.listings.expired", { count: expired });
    }
    return expired;
  }

  private async resolvePlatformFeeBps(): Promise<number> {
    if (!this.options.feeSchedule) return 0;
    try {
      return await this.options.feeSchedule.getFeeRate("secondaryMarketFeeBps");
    } catch (error) {
      if (error instanceof ServiceError && error.code === "NO_ACTIVE_FEE_SCHEDULE") {
        logger.warn("secondary.fee_schedule.missing", {
          fallback_bps: DEFAULT_SECONDARY_MARKET_FEE_BPS,
        });
        return DEFAULT_SECONDARY_MARKET_FEE_BPS;
      }
      throw error;
    }
  }

  /** Wallet that receives the issuer royalty, or null when it cannot be determined. */
  private async resolveIssuerWallet(
    manager: EntityManager,
    invoice: Invoice
  ): Promise<string | null> {
    if (invoice.sellerWallet) return invoice.sellerWallet;
    const issuer = await manager.findOne(User, { where: { id: invoice.sellerId } });
    return issuer?.stellarAddress ?? null;
  }

  /**
   * Cancel a listing (restricted to listing owner only). The listing row is
   * locked so a cancel cannot race a concurrent purchase. A listing already
   * past its expiry is moved to `expired` instead.
   */
  async cancelListing(
    listingId: string,
    sellerWallet: string,
    reason?: string,
    sellerId?: string,
    expectedVersion?: unknown
  ): Promise<SecondaryListing> {
    if (reason !== undefined && (typeof reason !== "string" || reason.length > 2000))
      throw new ServiceError(
        "INVALID_CANCELLATION_REASON",
        "reason must be a string of at most 2000 characters",
        400
      );
    const revision = this.parseRevision(expectedVersion);
    const outcome = await this.dataSource.transaction(async (manager: EntityManager) => {
      const listing = await manager.findOne(SecondaryListing, {
        where: { id: listingId },
        lock: { mode: "pessimistic_write" },
      });

      if (!listing) {
        throw new ServiceError("LISTING_NOT_FOUND", "Listing not found", 404);
      }

      const isOwner =
        listing.sellerWallet === sellerWallet ||
        (Boolean(sellerId) && Boolean(listing.sellerId) && listing.sellerId === sellerId);

      if (!isOwner) {
        throw new ServiceError("FORBIDDEN", "Only the listing owner can cancel this listing", 403);
      }

      if (
        listing.status === ListingStatus.CANCELLED &&
        listing.version === revision + 1 &&
        listing.cancellationReason === (reason || null)
      )
        return { expired: false as const, listing };
      this.assertRevision(listing, revision);
      if (listing.status !== ListingStatus.ACTIVE) {
        throw this.listingConflict(listing, revision, "Only active listings can be cancelled");
      }
      if (await manager.findOne(SecondaryTrade, { where: { listingId } })) {
        throw this.listingConflict(
          listing,
          revision,
          "A listing with completed purchases cannot be cancelled"
        );
      }

      if (isListingExpired(listing, this.now())) {
        transitionListing(listing, ListingStatus.EXPIRED);
        await manager.save(listing);
        return { expired: true as const };
      }

      transitionListing(listing, ListingStatus.CANCELLED);
      listing.cancellationReason = reason || null;
      const saved = await manager.save(listing);
      return { expired: false as const, listing: saved as SecondaryListing };
    });

    if (outcome.expired) {
      throw new ServiceError("LISTING_EXPIRED", "Listing has already expired", 400);
    }

    logger.info("secondary.listing.cancelled", {
      listing_id: listingId,
      seller_wallet: sellerWallet,
      reason,
    });

    return outcome.listing;
  }

  /** Update an active ask using the same revision precondition as cancellation. */
  async relistListing(
    listingId: string,
    sellerWallet: string,
    sellerId: string,
    body: Record<string, unknown>
  ): Promise<SecondaryListing> {
    const revision = this.parseRevision(body.expected_version);
    const quantity = parsePositiveAmount(body.quantity, "INVALID_QUANTITY", "Quantity");
    const price = parsePositiveAmount(
      body.price_per_fraction,
      "INVALID_PRICE",
      "Price per fraction"
    );
    return this.dataSource.transaction(async (manager) => {
      const listing = await manager.findOne(SecondaryListing, {
        where: { id: listingId },
        lock: { mode: "pessimistic_write" },
      });
      if (!listing) throw new ServiceError("LISTING_NOT_FOUND", "Listing not found", 404);
      if (listing.sellerWallet !== sellerWallet && listing.sellerId !== sellerId)
        throw new ServiceError("FORBIDDEN", "Only the listing owner can relist", 403);
      const traded = await manager.findOne(SecondaryTrade, { where: { listingId } });
      if (
        listing.status !== ListingStatus.ACTIVE ||
        isListingExpired(listing, this.now()) ||
        traded
      )
        throw this.listingConflict(
          listing,
          revision,
          "Only an active listing without purchases can be relisted"
        );
      if (
        listing.version === revision + 1 &&
        new Decimal(listing.quantity).eq(quantity) &&
        new Decimal(listing.pricePerFraction).eq(price)
      )
        return listing;
      this.assertRevision(listing, revision);
      const invoice = await manager.findOne(Invoice, {
        where: { id: listing.invoiceId },
        lock: { mode: "pessimistic_write" },
      });
      if (!invoice || invoice.status !== InvoiceStatus.FUNDED || isPastDueDate(invoice.dueDate))
        throw this.listingConflict(listing, revision, "Invoice is no longer tradable");
      const settling = await manager.findOne(SettlementIntent, {
        where: {
          invoiceId: invoice.id,
          status: In([
            SettlementIntentStatus.PREPARED,
            SettlementIntentStatus.SUBMITTING,
            SettlementIntentStatus.DISTRIBUTED,
          ]),
        },
      });
      if (settling)
        throw this.listingConflict(listing, revision, "Invoice settlement is in progress");
      const holdings = await manager.find(Investment, {
        where: [
          { invoiceId: invoice.id, investorId: sellerId, status: InvestmentStatus.CONFIRMED },
          {
            invoiceId: invoice.id,
            investorWallet: sellerWallet,
            status: InvestmentStatus.CONFIRMED,
          },
        ],
        lock: { mode: "pessimistic_write" },
      });
      const otherListings = await manager.find(SecondaryListing, {
        where: [
          { invoiceId: invoice.id, sellerId, status: ListingStatus.ACTIVE },
          { invoiceId: invoice.id, sellerWallet, status: ListingStatus.ACTIVE },
        ],
      });
      const reserved = otherListings
        .filter((row) => row.id !== listingId && !isListingExpired(row, this.now()))
        .reduce((sum, row) => sum.plus(row.quantity), new Decimal(0));
      const available = holdings
        .reduce((sum, row) => sum.plus(row.investmentAmount), new Decimal(0))
        .minus(reserved);
      if (quantity.gt(available))
        throw new ServiceError(
          "INSUFFICIENT_HOLDINGS",
          "Requested quantity exceeds available holdings",
          409
        );
      listing.quantity = quantity.toFixed(4);
      listing.pricePerFraction = price.toFixed(4);
      listing.totalPrice = quantity.times(price).toFixed(4);
      return manager.save(listing);
    });
  }

  private parseRevision(value: unknown): number {
    if (value === undefined || value === null)
      throw new ServiceError(
        "LISTING_PRECONDITION_REQUIRED",
        "expected_version is required; fetch the listing version before changing it",
        428
      );
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
      throw new ServiceError(
        "INVALID_LISTING_VERSION",
        "expected_version must be a positive integer",
        400
      );
    return value;
  }

  private assertRevision(listing: SecondaryListing, expected: number): void {
    if (listing.version !== expected)
      throw this.listingConflict(
        listing,
        expected,
        "Listing changed; fetch its current version before retrying"
      );
  }

  private listingConflict(
    listing: SecondaryListing,
    expected: number,
    message: string
  ): ServiceError {
    return new ServiceError("LISTING_CONFLICT", message, 409, {
      listing_id: listing.id,
      expected_version: expected,
      current_version: listing.version,
      status: listing.status,
      quantity: listing.quantity,
    });
  }

  private getSortColumn(sort: string): string {
    const sortMap: Record<string, string> = {
      price: "listing.pricePerFraction",
      expires_at: "listing.expiresAt",
      created_at: "listing.createdAt",
    };

    return sortMap[sort] || "listing.createdAt";
  }
}

export function createSecondaryMarketService(
  dataSource: DataSource,
  notificationService?: NotificationService,
  options?: SecondaryMarketOptions
): SecondaryMarketService {
  return new SecondaryMarketService(dataSource, notificationService, options);
}

/**
 * Invoice state machine effect (issue #783): when an invoice is funded, start
 * its secondary market lock-up. A no-op when the period is 0 or the invoice
 * already has a lock-up expiry.
 */
export function createLockUpOnFundingEffect(
  dataSource: DataSource,
  lockUpPeriodSeconds: number
): TransitionEffect {
  const startSecondaryLockUp: TransitionEffect = async (transition) => {
    if (transition.to !== InvoiceStatus.FUNDED || lockUpPeriodSeconds <= 0) return;
    const lockUpExpiry = new Date(transition.occurredAt.getTime() + lockUpPeriodSeconds * 1000);
    try {
      await dataSource
        .createQueryBuilder()
        .update(Invoice)
        .set({ lockUpExpiry })
        .where("id = :id", { id: transition.invoice.id })
        .andWhere("lock_up_expiry IS NULL")
        .execute();
    } catch (error) {
      logger.warn("secondary.lock_up.start_failed", {
        invoice_id: transition.invoice.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return startSecondaryLockUp;
}

/** Periodically moves expired active listings to `expired`. */
export function scheduleListingExpirySweep(
  service: SecondaryMarketService,
  intervalMs: number
): { stop: () => void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    service
      .expireStaleListings()
      .catch((error: unknown) => {
        logger.warn("secondary.listings.expiry_sweep_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
