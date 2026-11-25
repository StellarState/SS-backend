import { SellerService } from "../../src/services/seller.service";
import { Invoice } from "../../src/models/Invoice.model";
import { InvoiceStatus } from "../../src/types/enums";

describe("SellerService", () => {
  it("returns stored fundingDeadline separately from dueDate and falls back to dueDate only for legacy null values (#751)", async () => {
    const storedDeadline = new Date("2026-03-10T18:00:00.000Z");
    const maturityDate = new Date("2026-06-30T00:00:00.000Z");

    const invoices = [
      {
        id: "inv-with-deadline",
        sellerId: "seller-1",
        invoiceNumber: "INV-101",
        customerName: "Acme Corp",
        status: InvoiceStatus.PUBLISHED,
        amount: "1000.0000",
        netAmount: "950.0000",
        fundedAmount: "475.0000",
        fundingDeadline: storedDeadline,
        dueDate: maturityDate,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: "inv-legacy-null",
        sellerId: "seller-1",
        invoiceNumber: "INV-102",
        customerName: "Beta LLC",
        status: InvoiceStatus.FUNDED,
        amount: "2000.0000",
        netAmount: "1900.0000",
        fundedAmount: "1900.0000",
        fundingDeadline: null,
        dueDate: maturityDate,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ] as Invoice[];

    const mockInvoiceRepository = {
      find: jest.fn().mockResolvedValue(invoices),
    };

    const sellerService = new SellerService(mockInvoiceRepository as any);
    const dashboard = await sellerService.getDashboard("seller-1");

    expect(dashboard.invoices[0].fundingDeadline).toEqual(storedDeadline);
    expect(dashboard.invoices[0].dueDate).toEqual(maturityDate);

    expect(dashboard.invoices[1].fundingDeadline).toEqual(maturityDate);
    expect(dashboard.invoices[1].dueDate).toEqual(maturityDate);
  });
});
