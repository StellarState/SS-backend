import { Repository, DataSource, SelectQueryBuilder } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { InvoiceStatus } from "../types/enums";

export interface InvoiceFilters {
  sellerId?: string;
  status?: InvoiceStatus | InvoiceStatus[];
}

export type Database = DataSource | Repository<Invoice>;

export async function queryInvoicesPage(
  filters: InvoiceFilters,
  cursor: string | null,
  limit: number,
  db: Database
): Promise<{ data: Invoice[]; has_more: boolean; next_cursor: string | null }> {
  let queryBuilder: SelectQueryBuilder<Invoice>;
  
  if (db instanceof DataSource) {
    queryBuilder = db.getRepository(Invoice).createQueryBuilder("invoice");
  } else {
    queryBuilder = db.createQueryBuilder("invoice");
  }

  queryBuilder.where("invoice.deletedAt IS NULL");

  if (filters.sellerId) {
    queryBuilder.andWhere("invoice.sellerId = :sellerId", { sellerId: filters.sellerId });
  }

  if (filters.status) {
    if (Array.isArray(filters.status)) {
       if (filters.status.length > 0) {
         queryBuilder.andWhere("invoice.status IN (:...statuses)", { statuses: filters.status });
       }
    } else {
       queryBuilder.andWhere("invoice.status = :status", { status: filters.status });
    }
  }

  if (cursor) {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    const [createdAtStr, id] = decoded.split("|");
    const createdAt = new Date(createdAtStr);

    queryBuilder.andWhere(
      "(invoice.createdAt < :createdAt OR (invoice.createdAt = :createdAt AND invoice.id < :id))",
      { createdAt, id }
    );
  }

  queryBuilder.orderBy("invoice.createdAt", "DESC");
  queryBuilder.addOrderBy("invoice.id", "DESC");

  queryBuilder.take(limit + 1);

  const results = await queryBuilder.getMany();
  const hasMore = results.length > limit;
  const data = hasMore ? results.slice(0, limit) : results;

  let nextCursor = null;
  if (data.length > 0) {
    const lastItem = data[data.length - 1];
    nextCursor = Buffer.from(`${lastItem.createdAt.toISOString()}|${lastItem.id}`).toString("base64");
  }

  return {
    data,
    has_more: hasMore,
    next_cursor: nextCursor
  };
}
