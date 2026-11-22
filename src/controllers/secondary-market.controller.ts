import { Response } from "express";
import { SecondaryMarketService } from "../services/secondary-market.service";
import { AuthenticatedRequest } from "../types/auth";
import { ServiceError } from "../utils/service-error";
import { logger } from "../observability/logger";

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/** First defined value among the accepted aliases of a body field. */
function pick(body: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = first(body[key]);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function sendError(res: Response, err: unknown) {
  if (err instanceof ServiceError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
  }
  const statusCode = (err as { statusCode?: number }).statusCode;
  if (typeof statusCode === "number") {
    return res.status(statusCode).json({
      error: {
        code: (err as { code?: string }).code || "REQUEST_FAILED",
        message: (err as { message?: string }).message || "Request failed",
      },
    });
  }
  logger.error("secondary.request_failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  return res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Internal server error" },
  });
}

export class SecondaryMarketController {
  constructor(private readonly secondaryMarketService: SecondaryMarketService) {}

  /**
   * POST /secondary/listings
   * Body: { invoice_id, fractions, ask_price_per_fraction, expires_at? }
   * (camelCase `invoiceId`, `quantity`, `pricePerFraction`/`price`, `expiresAt`
   * are still accepted).
   */
  createListing = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const body = (req.body || {}) as Record<string, unknown>;
      const invoiceId = pick(body, "invoice_id", "invoiceId");
      const quantity = pick(body, "fractions", "quantity");
      const pricePerFraction = pick(body, "ask_price_per_fraction", "pricePerFraction", "price");
      const expiresAt = pick(body, "expires_at", "expiresAt");

      if (!invoiceId || !quantity || !pricePerFraction) {
        return res.status(400).json({
          error: {
            code: "MISSING_FIELDS",
            message: "invoice_id, fractions and ask_price_per_fraction are required",
          },
        });
      }

      const parsedExpiry = expiresAt ? new Date(String(expiresAt)) : undefined;
      if (parsedExpiry && Number.isNaN(parsedExpiry.getTime())) {
        return res.status(400).json({
          error: { code: "INVALID_EXPIRY", message: "expires_at must be a valid date" },
        });
      }

      const listing = await this.secondaryMarketService.createListing({
        invoiceId: String(invoiceId),
        sellerWallet: req.user.stellarAddress,
        sellerId: req.user.id,
        quantity: quantity as string | number,
        pricePerFraction: pricePerFraction as string | number,
        expiresAt: parsedExpiry,
      });

      return res.status(201).json({
        success: true,
        data: listing,
      });
    } catch (err: unknown) {
      return sendError(res, err);
    }
  };

  getListings = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const {
        invoiceId,
        sellerWallet,
        minPrice,
        maxPrice,
        sortBy = "created_at",
        sortOrder = "DESC",
        page = "1",
        limit = "20",
      } = req.query;

      const filters = {
        invoiceId: invoiceId as string | undefined,
        sellerWallet: sellerWallet as string | undefined,
        minPrice: minPrice ? Number(Array.isArray(minPrice) ? minPrice[0] : minPrice) : undefined,
        maxPrice: maxPrice ? Number(Array.isArray(maxPrice) ? maxPrice[0] : maxPrice) : undefined,
        sortBy: sortBy as string as "price" | "expires_at" | "created_at",
        sortOrder: sortOrder as string as "ASC" | "DESC",
      };

      const pagination = {
        page: Math.max(1, Number(Array.isArray(page) ? page[0] : page)),
        limit: Math.min(100, Math.max(1, Number(Array.isArray(limit) ? limit[0] : limit))),
      };

      const result = await this.secondaryMarketService.getListings(filters, pagination);

      return res.status(200).json({
        success: true,
        data: result.data,
        meta: result.meta,
      });
    } catch (err: unknown) {
      return sendError(res, err);
    }
  };

  getListingById = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const listingId = Array.isArray(id) ? id[0] : id;

      const listing = await this.secondaryMarketService.getListingById(listingId);

      return res.status(200).json({
        success: true,
        data: listing,
      });
    } catch (err: unknown) {
      return sendError(res, err);
    }
  };

  /**
   * POST /secondary/listings/:id/purchase (alias: /buy)
   * Body: { fractions? } — defaults to the whole remaining listing.
   */
  buyListing = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { id } = req.params;
      const body = (req.body || {}) as Record<string, unknown>;
      const quantity = pick(body, "fractions", "quantity");

      const result = await this.secondaryMarketService.buyListing({
        listingId: Array.isArray(id) ? id[0] : id,
        buyerWallet: req.user.stellarAddress,
        buyerId: req.user.id,
        quantity: quantity as string | number | undefined,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: unknown) {
      return sendError(res, err);
    }
  };

  relistListing = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user)
        return res
          .status(401)
          .json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Authentication required" },
          });
      const listing = await this.secondaryMarketService.relistListing(
        String(req.params.id),
        req.user.stellarAddress,
        req.user.id,
        req.body ?? {}
      );
      return res.status(200).json({ success: true, data: listing });
    } catch (error) {
      return sendError(res, error);
    }
  };
  cancelListing = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { id } = req.params;
      const { reason, expected_version } = req.body || {};

      const listing = await this.secondaryMarketService.cancelListing(
        Array.isArray(id) ? id[0] : id,
        req.user.stellarAddress,
        reason,
        req.user.id,
        expected_version
      );

      return res.status(200).json({
        success: true,
        data: listing,
      });
    } catch (err: unknown) {
      return sendError(res, err);
    }
  };
}
