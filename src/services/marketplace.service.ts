import { DataSource } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { InvoiceStatus } from "../types/enums";
import { TypeORMMarketplaceRepository } from "../repositories/marketplace.repository";

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
      sort: filters.sort || "amount",
      sortOrder: filters.sortOrder || "DESC",
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

export function createMarketplaceService(dataSource: DataSource): MarketplaceService {
  return new MarketplaceService({
    marketplaceRepository: new TypeORMMarketplaceRepository(dataSource),
  });
}