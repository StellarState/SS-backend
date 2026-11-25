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

    const sellerService = new SellerService(mockInvoiceRepository as any, { find: jest.fn().mockResolvedValue([]) } as any);
    const dashboard = await sellerService.getDashboard("seller-1");

    expect(dashboard.invoices[0].fundingDeadline).toEqual(storedDeadline);
    expect(dashboard.invoices[0].dueDate).toEqual(maturityDate);

    expect(dashboard.invoices[1].fundingDeadline).toEqual(maturityDate);
    expect(dashboard.invoices[1].dueDate).toEqual(maturityDate);
  });

  describe("totalRepaid from recorded settlements (#752)", () => {
    const makeInvoice = (id: string, status: InvoiceStatus, netAmount: string) =>
      ({
        id,
        sellerId: "seller-1",
        invoiceNumber: `INV-${id}`,
        customerName: "Acme",
        status,
        amount: "1100.0000",
        netAmount,
        fundedAmount: netAmount,
        fundingDeadline: null,
        dueDate: new Date("2026-06-30T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }) as Invoice;

    const build = (invoices: Invoice[], records: any[]) => {
      const invoiceRepo = { find: jest.fn().mockResolvedValue(invoices) };
      const settlementRepo = { find: jest.fn().mockResolvedValue(records) };
      return {
        service: new SellerService(invoiceRepo as any, settlementRepo as any),
        settlementRepo,
      };
    };

    it("reports recorded gross repayment (1000) rather than the 900 raised", async () => {
      const { service } = build(
        [makeInvoice("a", InvoiceStatus.SETTLED, "900.0000")],
        [
          {
            invoiceId: "a",
            totalSettlementAmount: "1000.0000",
            totalDistributedAmount: "990.0000",
            remainderAmount: "0.0003",
          },
        ]
      );
      const dashboard = await service.getDashboard("seller-1");
      expect(dashboard.totalRepaid).toBe("1000.0000");
      expect(dashboard.totalDistributed).toBe("990.0000");
      expect(dashboard.totalRaised).toBe("900.0000");
    });

    it("aggregates multiple settlements exactly", async () => {
      const { service } = build(
        [
          makeInvoice("a", InvoiceStatus.SETTLED, "900.0000"),
          makeInvoice("b", InvoiceStatus.SETTLED, "450.0000"),
        ],
        [
          { invoiceId: "a", totalSettlementAmount: "1000.1000", totalDistributedAmount: "990.0999" },
          { invoiceId: "b", totalSettlementAmount: "500.2002", totalDistributedAmount: "495.2001" },
        ]
      );
      const dashboard = await service.getDashboard("seller-1");
      expect(dashboard.totalRepaid).toBe("1500.3002");
      expect(dashboard.totalDistributed).toBe("1485.3000");
    });

    it("does not fabricate repayment for settled invoices without a settlement record", async () => {
      const { service } = build([makeInvoice("a", InvoiceStatus.SETTLED, "900.0000")], []);
      const dashboard = await service.getDashboard("seller-1");
      expect(dashboard.totalSettled).toBe(1);
      expect(dashboard.totalRepaid).toBe("0.0000");
      expect(dashboard.totalDistributed).toBe("0.0000");
    });

    it("only queries settlement records for the seller's own invoices", async () => {
      const { service, settlementRepo } = build(
        [makeInvoice("a", InvoiceStatus.SETTLED, "900.0000")],
        []
      );
      await service.getDashboard("seller-1");
      const where = settlementRepo.find.mock.calls[0][0].where;
      expect(where.invoiceId.value).toEqual(["a"]);
    });
  });
});
