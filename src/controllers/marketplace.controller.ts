import type { Request, Response, NextFunction } from "express";
import Joi from "joi";
import type { MarketplaceService, MarketplaceFilters, PaginationOptions } from "../services/marketplace.service";
import { InvoiceStatus } from "../types/enums";
import { HttpError } from "../utils/http-error";
import { ServiceError } from "../utils/service-error";

const getInvoicesSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.alternatives().try(
    Joi.string().valid(...Object.values(InvoiceStatus)),
    Joi.array().items(Joi.string().valid(...Object.values(InvoiceStatus))),
  ).optional(),
  dueBefore: Joi.date().iso().optional(),
  minAmount: Joi.number().min(0).optional(),
  maxAmount: Joi.number().min(0).optional(),
  sort: Joi.string().valid("due_date", "discount_rate", "amount", "created_at").default("due_date"),
  sortOrder: Joi.string().valid("ASC", "DESC").default("ASC"),
});

export interface GetInvoicesRequest extends Request {
  query: {
    page?: string;
    limit?: string;
    status?: string | string[];
    dueBefore?: string;
    minAmount?: string;
    maxAmount?: string;
    sort?: string;
    sortOrder?: string;
  };
}

export function createMarketplaceController(marketplaceService: MarketplaceService) {
  return {
    async getInvoices(
      req: GetInvoicesRequest,
      res: Response,
      next: NextFunction,
    ): Promise<void> {
      try {
        // Validate query parameters
        const { error, value } = getInvoicesSchema.validate(req.query, {
          stripUnknown: true,
          convert: true,
        });

        if (error) {
          throw new HttpError(400, `Invalid query parameters: ${error.message}`);
        }

        // Parse and normalize filters
        const filters: MarketplaceFilters = {
          status: Array.isArray(value.status) ? value.status : value.status ? [value.status] : undefined,
          dueBefore: value.dueBefore,
          minAmount: value.minAmount,
          maxAmount: value.maxAmount,
          sort: value.sort,
          sortOrder: value.sortOrder,
        };

        // Validate amount range
        if (filters.minAmount !== undefined && filters.maxAmount !== undefined) {
          if (filters.minAmount > filters.maxAmount) {
            throw new HttpError(400, "minAmount cannot be greater than maxAmount");
          }
        }

        const pagination: PaginationOptions = {
          page: value.page,
          limit: value.limit,
        };

        const result = await marketplaceService.getPublishedInvoices(filters, pagination);

        res.status(200).json({
          success: true,
          data: result.data,
          meta: result.meta,
        });
      } catch (error) {
        if (error instanceof ServiceError) {
          next(new HttpError(error.statusCode, error.message));
          return;
        }

        next(error);
      }
    },
  };
}