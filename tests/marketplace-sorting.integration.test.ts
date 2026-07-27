import crypto from "crypto";
import { MarketplaceService } from "../src/services/marketplace.service";
import { Invoice } from "../src/models/Invoice.model";
import { InvoiceStatus } from "../src/types/enums";
import { createFakeMarketplaceRepository } from "./helpers/create-fake-repository";

function createInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: crypto.randomUUID(),
    sellerId: crypto.randomUUID(),
    invoiceNumber: `INV-${crypto.randomUUID().slice(0, 8)}`,
    customerName: "Customer",
    amount: "1000.0000",
    discountRate: "5.00",
    netAmount: "950.0000",
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    ipfsHash: "QmTestHash",
    riskScore: null,
    status: InvoiceStatus.PUBLISHED,
    smartContractId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    seller: undefined as unknown as Invoice["seller"],
    investments: [],
    transactions: [],
    ...overrides,
  } as Invoice;
}

describe("Marketplace listing integration: default sorting by face value", () => {
  const invoice5k = createInvoice({
    status: InvoiceStatus.PUBLISHED,
    amount: "5000.00",
  });
  const invoice12k = createInvoice({
    status: InvoiceStatus.PUBLISHED,
    amount: "12000.00",
  });
  const invoice8k = createInvoice({
    status: InvoiceStatus.PUBLISHED,
    amount: "8000.00",
  });

  const allInvoices = [invoice5k, invoice12k, invoice8k];

  function createService(): MarketplaceService {
    return new MarketplaceService({
      marketplaceRepository: createFakeMarketplaceRepository(allInvoices),
    });
  }

  it("returns invoices sorted by face value (amount) descending by default", async () => {
    const marketplaceService = createService();

    // Call with no sort parameters to test the default behavior
    const result = await marketplaceService.getPublishedInvoices();

    expect(result.data).toHaveLength(3);
    expect(result.data.map((invoice) => invoice.id)).toEqual([invoice12k.id, invoice8k.id, invoice5k.id]);
    expect(result.data[0].amount).toBe("12000.00");
    expect(result.data[1].amount).toBe("8000.00");
    expect(result.data[2].amount).toBe("5000.00");
  });
});