import { DataSource, Repository } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { InvoiceStatus } from "../types/enums";

export interface MarketplaceFilters {
  status?: InvoiceStatus[];
  dueBefore?: Date;
  minAmount?: number;
  maxAmount?: number;
  sort?: "due_date" | "discount_rate" | "amount" | "created_at";
  sortOrder?: "ASC" | "DESC";
}

export interface PaginationOptions {
  page: number;
  limit: number;
}

export interface PublicInvoice {
  id: string;
  invoiceNumber: string;
  customerName: string;
  amount: string;
  discountRate: string;
  netAmount: string;
  dueDate: Date;
  status: InvoiceStatus;
  createdAt: Date;
  // Excluded: sellerId, ipfsHash, riskScore, smartContractId, updatedAt, deletedAt
}

export interface MarketplaceResponse {
  data: PublicInvoice[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface MarketplaceRepositoryContract {
  findPublishedInvoices(
    filters: MarketplaceFilters,
    pagination: PaginationOptions,
  ): Promise<{ invoices: Invoice[]; total: number }>;
}

export interface MarketplaceServiceDependencies {
  marketplaceRepository: MarketplaceRepositoryContract;
}

export class MarketplaceService {
  private readonly marketplaceRepository: MarketplaceRepositoryContract;

  constructor(dependencies: MarketplaceServiceDependencies) {
    this.marketplaceRepository = dependencies.marketplaceRepository;
  }

  async getPublishedInvoices(
    filters: MarketplaceFilters = {},
    pagination: PaginationOptions = { page: 1, limit: 20 },
  ): Promise<MarketplaceResponse> {
    // Set default filters
    const normalizedFilters: MarketplaceFilters = {
      status: filters.status || [InvoiceStatus.PUBLISHED],
      dueBefore: filters.dueBefore,
      minAmount: filters.minAmount,
      maxAmount: filters.maxAmount,
      sort: filters.sort || "due_date",
      sortOrder: filters.sortOrder || "ASC",
    };

    // Validate pagination
    const normalizedPagination: PaginationOptions = {
      page: Math.max(1, pagination.page),
      limit: Math.min(100, Math.max(1, pagination.limit)), // Max 100 items per page
    };

    const { invoices, total } = await this.marketplaceRepository.findPublishedInvoices(
      normalizedFilters,
      normalizedPagination,
    );

    const publicInvoices: PublicInvoice[] = invoices.map(this.toPublicInvoice);

    return {
      data: publicInvoices,
      meta: {
        total,
        page: normalizedPagination.page,
        limit: normalizedPagination.limit,
        totalPages: Math.ceil(total / normalizedPagination.limit),
      },
    };
  }

  private toPublicInvoice(invoice: Invoice): PublicInvoice {
    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      customerName: invoice.customerName,
      amount: invoice.amount,
      discountRate: invoice.discountRate,
      netAmount: invoice.netAmount,
      dueDate: invoice.dueDate,
      status: invoice.status,
      createdAt: invoice.createdAt,
    };
  }
}

class TypeORMMarketplaceRepository implements MarketplaceRepositoryContract {
  private readonly repository: Repository<Invoice>;

  constructor(repository: Repository<Invoice>) {
    this.repository = repository;
  }

  async findPublishedInvoices(
    filters: MarketplaceFilters,
    pagination: PaginationOptions,
  ): Promise<{ invoices: Invoice[]; total: number }> {
    const queryBuilder = this.repository
      .createQueryBuilder("invoice")
      .where("invoice.deleted_at IS NULL");

    // Apply status filter
    if (filters.status && filters.status.length > 0) {
      queryBuilder.andWhere("invoice.status IN (:...statuses)", {
        statuses: filters.status,
      });
    }

    // Apply date filter
    if (filters.dueBefore) {
      queryBuilder.andWhere("invoice.due_date <= :dueBefore", {
        dueBefore: filters.dueBefore,
      });
    }

    // Apply amount filters
    if (filters.minAmount !== undefined) {
      queryBuilder.andWhere("CAST(invoice.amount AS DECIMAL) >= :minAmount", {
        minAmount: filters.minAmount,
      });
    }

    if (filters.maxAmount !== undefined) {
      queryBuilder.andWhere("CAST(invoice.amount AS DECIMAL) <= :maxAmount", {
        maxAmount: filters.maxAmount,
      });
    }

    // Apply sorting with stable ordering
    const sortColumn = this.getSortColumn(filters.sort || "due_date");
    queryBuilder.orderBy(sortColumn, filters.sortOrder || "ASC");
    queryBuilder.addOrderBy("invoice.id", "ASC"); // Stable sort

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const offset = (pagination.page - 1) * pagination.limit;
    queryBuilder.skip(offset).take(pagination.limit);

    const invoices = await queryBuilder.getMany();

    return { invoices, total };
  }

  private getSortColumn(sort: string): string {
    const sortMap: Record<string, string> = {
      due_date: "invoice.due_date",
      discount_rate: "invoice.discount_rate",
      amount: "invoice.amount",
      created_at: "invoice.created_at",
    };

    return sortMap[sort] || "invoice.due_date";
  }
}

export function createMarketplaceService(dataSource: DataSource): MarketplaceService {
  const invoiceRepository = dataSource.getRepository(Invoice);
  const marketplaceRepository = new TypeORMMarketplaceRepository(invoiceRepository);

  return new MarketplaceService({
    marketplaceRepository,
  });
}