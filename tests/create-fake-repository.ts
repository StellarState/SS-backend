import { MarketplaceFilters, MarketplaceRepositoryContract } from "../src/services/marketplace.service";
import { Invoice } from "../src/models/Invoice.model";
import { InvoiceStatus } from "../src/types/enums";

/**
 * In-memory stand-in for the TypeORM-backed marketplace repository. Mirrors
 * the real repository's status filtering (defaulting to PUBLISHED, or the
 * exact statuses requested) so tests can exercise the real
 * MarketplaceService filtering logic end to end without a live database.
 */
export function createFakeMarketplaceRepository(invoices: Invoice[]): MarketplaceRepositoryContract {
  return {
    async findPublishedInvoices(filters: MarketplaceFilters) {
      const statuses = filters.status && filters.status.length > 0 ? filters.status : [InvoiceStatus.PUBLISHED];
      const matched = invoices.filter((invoice) => statuses.includes(invoice.status));
      return { invoices: matched, total: matched.length };
    },
  };
}