import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ObjectLiteral, SelectQueryBuilder } from "typeorm";
import { PublicAppError } from "../utils/http-error";
import { ServiceError } from "../utils/service-error";
import {
  decodeSecureCursor,
  encodeSecureCursor,
  type CursorPosition,
  type CursorValue,
} from "../utils/secure-cursor";

/**
 * Reusable cursor-based pagination for list endpoints (issue #559).
 *
 * The middleware reads `cursor`, `limit`, `sort` and `order` from the query,
 * validates them, and puts the result on `req.pagination`. Handlers then page
 * with {@link paginateQuery}, which applies a keyset filter on
 * (sort column, id). Because a page starts strictly after the last row of the
 * previous one, rows are neither repeated nor skipped at page boundaries, even
 * while new rows are being inserted.
 *
 * Responses carry `next_cursor` only when another page exists.
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface CursorPagination {
  /** Endpoint the cursors belong to; a cursor from another scope is rejected. */
  scope: string;
  limit: number;
  /** Public sort key, e.g. "created_at". */
  sort: string;
  order: "ASC" | "DESC";
  /** Position to resume after, or null for the first page. */
  after: CursorPosition | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      pagination?: CursorPagination;
    }
  }
}

export interface CursorPaginationOptions {
  /** Unique per endpoint, e.g. "watchlist". */
  scope: string;
  /** Public sort keys this endpoint accepts. Defaults to `[defaultSort]`. */
  sortKeys?: readonly string[];
  defaultSort?: string;
  defaultOrder?: "ASC" | "DESC";
}

function firstValue(value: unknown): string | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  // Numbers too: a Joi query schema ahead of this middleware may have
  // already converted `limit`.
  if (typeof single === "number") return String(single);
  return typeof single === "string" ? single : undefined;
}

function badRequest(message: string, code: string): PublicAppError {
  return new PublicAppError(400, message, code);
}

export function cursorPagination({
  scope,
  sortKeys,
  defaultSort = "created_at",
  defaultOrder = "DESC",
}: CursorPaginationOptions): RequestHandler {
  const allowedSorts = new Set(sortKeys ?? [defaultSort]);

  return (req: Request, _res: Response, next: NextFunction): void => {
    const query = req.query ?? {};

    const rawLimit = firstValue(query.limit);
    let limit = DEFAULT_PAGE_SIZE;
    if (rawLimit !== undefined && rawLimit !== "") {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1) {
        next(badRequest("limit must be a positive integer.", "INVALID_PAGE_SIZE"));
        return;
      }
      limit = Math.min(parsed, MAX_PAGE_SIZE);
    }

    // `sortBy`/`sortOrder` are accepted too, the names some endpoints already used.
    const sort = firstValue(query.sort) || firstValue(query.sortBy) || defaultSort;
    if (!allowedSorts.has(sort)) {
      next(
        badRequest(
          `sort must be one of: ${[...allowedSorts].join(", ")}.`,
          "INVALID_SORT"
        )
      );
      return;
    }

    const rawOrder = (
      firstValue(query.order) ||
      firstValue(query.sortOrder) ||
      defaultOrder
    ).toUpperCase();
    if (rawOrder !== "ASC" && rawOrder !== "DESC") {
      next(badRequest("order must be asc or desc.", "INVALID_SORT_ORDER"));
      return;
    }
    const order = rawOrder;

    const rawCursor = firstValue(query.cursor);
    let after: CursorPosition | null = null;
    if (rawCursor) {
      try {
        after = decodeSecureCursor(scope, rawCursor);
      } catch {
        next(badRequest("Invalid or expired pagination cursor.", "INVALID_CURSOR"));
        return;
      }
      if (after.sort !== sort || after.order !== order) {
        next(
          badRequest(
            "This cursor was issued for a different sort order; start again without a cursor.",
            "INVALID_CURSOR"
          )
        );
        return;
      }
    }

    req.pagination = { scope, limit, sort, order, after };
    next();
  };
}

export interface CursorPage<T> {
  items: T[];
  /** Present only when another page exists. */
  nextCursor?: string;
  hasMore: boolean;
}

export interface KeysetColumns<T> {
  /** Alias-qualified sort column, e.g. "watchlist.createdAt". */
  sortColumn: string;
  /** Alias-qualified unique tiebreaker, e.g. "watchlist.id". */
  idColumn: string;
  /** Reads the sort value and id off a returned row, to build the next cursor. */
  position(row: T): { value: CursorValue; id: string };
}

/**
 * Pages a query builder that already has its filters and joins applied.
 * Adds the keyset filter, ordering, and a one-row over-fetch to tell whether
 * another page exists.
 */
export async function paginateQuery<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  pagination: CursorPagination,
  columns: KeysetColumns<T>
): Promise<CursorPage<T>> {
  const { order, after, limit } = pagination;
  const comparator = order === "DESC" ? "<" : ">";

  if (after) {
    qb.andWhere(
      `(${columns.sortColumn} ${comparator} :cursorValue OR (${columns.sortColumn} = :cursorValue AND ${columns.idColumn} ${comparator} :cursorId))`,
      { cursorValue: after.value, cursorId: after.id }
    );
  }

  qb.orderBy(columns.sortColumn, order).addOrderBy(columns.idColumn, order).take(limit + 1);

  const rows = await qb.getMany();
  return buildCursorPage(rows, pagination, columns.position);
}

/** Turns an over-fetched result (up to limit + 1 rows) into a page. */
export function buildCursorPage<T>(
  rows: T[],
  pagination: CursorPagination,
  position: (row: T) => { value: CursorValue; id: string }
): CursorPage<T> {
  const hasMore = rows.length > pagination.limit;
  const items = hasMore ? rows.slice(0, pagination.limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    hasMore,
    ...(hasMore && last
      ? {
          nextCursor: encodeSecureCursor(pagination.scope, {
            sort: pagination.sort,
            order: pagination.order,
            ...position(last),
          }),
        }
      : {}),
  };
}

/** The `pagination` block list endpoints return. */
export function paginationMeta(
  page: { hasMore: boolean; nextCursor?: string },
  pagination: CursorPagination
): { limit: number; has_more: boolean; next_cursor?: string } {
  return {
    limit: pagination.limit,
    has_more: page.hasMore,
    ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
  };
}

/** Converts an `invalid_cursor` ServiceError into the endpoint's 400. */
export function toInvalidCursorError(error: unknown): unknown {
  return error instanceof ServiceError && error.code === "invalid_cursor"
    ? badRequest(error.message, "INVALID_CURSOR")
    : error;
}
