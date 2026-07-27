import { MarketplaceFilters, MarketplaceRepositoryContract } from "../../../src/services/marketplace.service";
import { Invoice } from "../../../src/models/Invoice.model";
import { InvoiceStatus } from "../../../src/types/enums";

export function createFakeMarketplaceRepository(invoices: Invoice[]): MarketplaceRepositoryContract {
  return {
    async findPublishedInvoices(filters: MarketplaceFilters) {
      const statuses =
        filters.status && filters.status.length > 0 ? filters.status : [InvoiceStatus.PUBLISHED];

      let matched = invoices.filter((inv) => statuses.includes(inv.status) && inv.deletedAt == null);

      const sort = filters.sort ?? "amount";
      const sortOrder = filters.sortOrder ?? "DESC";

      matched = [...matched].sort((a, b) => {
        let aVal: number;
        let bVal: number;

        switch (sort) {
          case "due_date":
            aVal = a.dueDate.getTime();
            bVal = b.dueDate.getTime();
            break;
          case "discount_rate":
            aVal = parseFloat(a.discountRate);
            bVal = parseFloat(b.discountRate);
            break;
          case "created_at":
            aVal = a.createdAt.getTime();
            bVal = b.createdAt.getTime();
            break;
          case "amount":
          default:
            aVal = parseFloat(a.amount);
            bVal = parseFloat(b.amount);
        }

        const diff = aVal - bVal;
        return sortOrder === "DESC" ? -diff : diff;
      });

      return { invoices: matched, total: matched.length };
    },
  };
}
