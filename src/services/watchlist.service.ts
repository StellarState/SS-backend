import { randomUUID } from "crypto";
import { DataSource, EntityManager } from "typeorm";
import type { QueryDeepPartialEntity } from "typeorm/query-builder/QueryPartialEntity";
import { Watchlist } from "../models/Watchlist.model";
import { Invoice } from "../models/Invoice.model";
import { InvoiceStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { logger } from "../observability/logger";

export interface PaginationOptions {
  page: number;
  limit: number;
}

export interface WatchlistEntry {
  id: string;
  invoiceId: string;
  walletAddress: string;
  notes: Record<string, unknown> | null;
  createdAt: Date;
  invoice: {
    id: string;
    invoiceNumber: string;
    customerName: string;
    amount: string;
    discountRate: string;
    netAmount: string;
    dueDate: Date;
    status: InvoiceStatus;
  };
}

export interface WatchlistResult {
  data: WatchlistEntry[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface AddToWatchlistResult {
  /** The watchlist entry as it exists after the call. */
  entry: Watchlist;
  /** True when this call created (or restored) the entry, false when it already existed. */
  created: boolean;
}

export interface RemoveFromWatchlistResult {
  /** True when this call deleted a row, false when the entry was already absent. */
  removed: boolean;
}

/**
 * Any 8-4-4-4-12 hex UUID. Postgres' `uuid` type accepts every version, so the
 * version nibble is not restricted here.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Normalize a Stellar wallet address so retries with cosmetic differences
 * (surrounding whitespace, lower-case input) resolve to the same row.
 * Stellar public keys are upper-case base32, so upper-casing is lossless.
 */
export function normalizeWalletAddress(walletAddress: string): string {
  const normalized = (walletAddress ?? "").trim().toUpperCase();
  if (!normalized) {
    throw new ServiceError("INVALID_WALLET_ADDRESS", "walletAddress is required", 400);
  }
  return normalized;
}

/**
 * Normalize an invoice identifier to its canonical lower-case UUID form.
 * Postgres compares `uuid` values case-insensitively, but other stores and
 * log keys do not, so identifiers are canonicalized before every read/write.
 */
export function normalizeInvoiceId(invoiceId: string): string {
  const normalized = (invoiceId ?? "").trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new ServiceError("INVALID_INVOICE_ID", "invoiceId must be a valid UUID", 400);
  }
  return normalized;
}

export class WatchlistService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Add an invoice to a wallet's watchlist. Idempotent: repeating the call,
   * sequentially or concurrently, never creates a duplicate and never fails
   * with a uniqueness error; it returns the entry that exists afterwards.
   *
   * The insert uses `ON CONFLICT DO NOTHING` (Postgres) / `INSERT OR IGNORE`
   * (SQLite) against `uq_watchlist_wallet_invoice`, so the database, not a
   * read-then-write check, arbitrates concurrent adds. Exactly one caller sees
   * `created: true`; every other caller reads back the winner's row.
   *
   * When the entry already exists its `notes` are left unchanged (first write
   * wins), so a delayed retry cannot overwrite newer state.
   */
  async addToWatchlist(
    walletAddress: string,
    invoiceId: string,
    userId?: string,
    notes?: Record<string, unknown>
  ): Promise<AddToWatchlistResult> {
    const wallet = normalizeWalletAddress(walletAddress);
    const normalizedInvoiceId = normalizeInvoiceId(invoiceId);

    return this.dataSource.transaction(async (manager: EntityManager) => {
      const invoice = await manager.findOne(Invoice, { where: { id: normalizedInvoiceId } });
      if (!invoice) {
        throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
      }

      // Generate the id up front so we can tell afterwards whether our insert
      // won or was ignored in favour of an existing row.
      const candidateId = randomUUID();
      await manager
        .createQueryBuilder()
        .insert()
        .into(Watchlist)
        .values({
          id: candidateId,
          walletAddress: wallet,
          userId: userId || null,
          invoiceId: normalizedInvoiceId,
          // jsonb column: the insert builder's deep-partial typing can't express
          // an arbitrary record, so state the column type explicitly.
          notes: (notes || null) as QueryDeepPartialEntity<Watchlist>["notes"],
        })
        .orIgnore()
        .execute();

      const entry = await manager.findOne(Watchlist, {
        where: { walletAddress: wallet, invoiceId: normalizedInvoiceId },
        withDeleted: true,
      });

      if (!entry) {
        // Only reachable when a concurrent remove commits between our ignored
        // insert and this read. The add lost the race to a later remove, so
        // report a retryable conflict instead of a state that no longer exists.
        throw new ServiceError(
          "WATCHLIST_CONCURRENT_MODIFICATION",
          "Watchlist entry was modified concurrently; retry the request",
          409
        );
      }

      let created = entry.id === candidateId;

      // The unique index also covers soft-deleted rows, so a soft-deleted
      // entry blocks the insert. Restore it rather than failing.
      if (entry.deletedAt) {
        await manager.restore(Watchlist, { id: entry.id });
        entry.deletedAt = null;
        created = true;
      }

      logger.info(created ? "watchlist.entry.created" : "watchlist.entry.already_present", {
        watchlist_id: entry.id,
        wallet_address: wallet,
        invoice_id: normalizedInvoiceId,
      });

      return { entry, created };
    });
  }

  /**
   * Remove an invoice from a wallet's watchlist. Idempotent: removing an
   * entry that does not exist succeeds, so retries always converge on
   * "absent". A single conditional DELETE leaves no read-then-write window
   * for a concurrent request to slip into.
   */
  async removeFromWatchlist(
    walletAddress: string,
    invoiceId: string
  ): Promise<RemoveFromWatchlistResult> {
    const wallet = normalizeWalletAddress(walletAddress);
    const normalizedInvoiceId = normalizeInvoiceId(invoiceId);

    const result = await this.dataSource
      .createQueryBuilder()
      .delete()
      .from(Watchlist)
      .where("wallet_address = :wallet", { wallet })
      .andWhere("invoice_id = :invoiceId", { invoiceId: normalizedInvoiceId })
      .execute();

    const removed = (result.affected ?? 0) > 0;

    logger.info(removed ? "watchlist.entry.removed" : "watchlist.entry.already_absent", {
      wallet_address: wallet,
      invoice_id: normalizedInvoiceId,
    });

    return { removed };
  }

  /**
   * Get paginated list of bookmarked invoices with current status.
   * Status data is joined from invoice table on list fetch.
   */
  async getWatchlist(
    walletAddress: string,
    pagination: PaginationOptions = { page: 1, limit: 20 }
  ): Promise<WatchlistResult> {
    const wallet = normalizeWalletAddress(walletAddress);
    const repository = this.dataSource.getRepository(Watchlist);
    const queryBuilder = repository
      .createQueryBuilder("watchlist")
      .leftJoinAndSelect("watchlist.invoice", "invoice")
      .where("watchlist.wallet_address = :walletAddress", { walletAddress: wallet })
      .andWhere("watchlist.deleted_at IS NULL")
      // Property name, not column name: with a join plus skip/take TypeORM
      // resolves orderBy keys against entity metadata and throws on
      // "watchlist.created_at".
      .orderBy("watchlist.createdAt", "DESC");

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const offset = (pagination.page - 1) * pagination.limit;
    queryBuilder.skip(offset).take(pagination.limit);

    const entries = await queryBuilder.getMany();

    const data: WatchlistEntry[] = entries.map((entry) => ({
      id: entry.id,
      invoiceId: entry.invoiceId,
      walletAddress: entry.walletAddress,
      notes: entry.notes,
      createdAt: entry.createdAt,
      invoice: {
        id: entry.invoice.id,
        invoiceNumber: entry.invoice.invoiceNumber,
        customerName: entry.invoice.customerName,
        amount: entry.invoice.amount,
        discountRate: entry.invoice.discountRate,
        netAmount: entry.invoice.netAmount,
        dueDate: entry.invoice.dueDate,
        status: entry.invoice.status,
      },
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
   * Check if an invoice is in a wallet's watchlist.
   */
  async isInWatchlist(walletAddress: string, invoiceId: string): Promise<boolean> {
    const repository = this.dataSource.getRepository(Watchlist);
    const entry = await repository.findOne({
      where: {
        walletAddress: normalizeWalletAddress(walletAddress),
        invoiceId: normalizeInvoiceId(invoiceId),
      },
    });
    return !!entry;
  }
}

export function createWatchlistService(dataSource: DataSource): WatchlistService {
  return new WatchlistService(dataSource);
}
