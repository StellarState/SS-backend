import { DataSource } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { InvoiceStatus } from "../types/enums";
import {
  MarketplaceFilters,
  MarketplaceRepositoryContract,
  PaginationOptions,
} from "../services/marketplace.service";

export class TypeORMMarketplaceRepository implements MarketplaceRepositoryContract {
  private readonly dataSource: DataSource;

  constructor(dataSource: DataSource) {
    this.dataSource = dataSource;
  }

  async findPublishedInvoices(
    filters: MarketplaceFilters,
    pagination: PaginationOptions,
  ): Promise<{ invoices: Invoice[]; total: number }> {
    const repository = this.dataSource.getRepository(Invoice);
    const qb = repository.createQueryBuilder("invoice").where("invoice.deletedAt IS NULL");

    if (filters.status && filters.status.length > 0) {
      qb.andWhere("invoice.status IN (:...statuses)", { statuses: filters.status });
    } else {
      qb.andWhere("invoice.status IN (:...statuses)", { statuses: [InvoiceStatus.PUBLISHED] });
    }

    if (filters.dueBefore) {
      qb.andWhere("invoice.dueDate <= :dueBefore", { dueBefore: filters.dueBefore });
    }

    if (filters.minAmount !== undefined) {
      qb.andWhere("CAST(invoice.amount AS DECIMAL) >= :minAmount", { minAmount: filters.minAmount });
    }

    if (filters.maxAmount !== undefined) {
      qb.andWhere("CAST(invoice.amount AS DECIMAL) <= :maxAmount", { maxAmount: filters.maxAmount });
    }

    const sortColumn = this.getSortColumn(filters.sort ?? "amount");
    qb.orderBy(sortColumn, filters.sortOrder ?? "DESC");
    qb.addOrderBy("invoice.id", "ASC");

    const total = await qb.getCount();

    qb.skip((pagination.page - 1) * pagination.limit).take(pagination.limit);

    const invoices = await qb.getMany();

    return { invoices, total };
  }

  private getSortColumn(sort: string): string {
    const sortMap: Record<string, string> = {
      due_date: "invoice.dueDate",
      discount_rate: "invoice.discountRate",
      amount: "invoice.amount",
      created_at: "invoice.createdAt",
    };
    return sortMap[sort] ?? "invoice.amount";
  }
}
