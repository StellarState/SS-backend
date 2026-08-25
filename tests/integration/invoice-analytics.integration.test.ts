import { InvoiceService } from "../../src/services/invoice.service";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { User } from "../../src/models/User.model";
import { InvoiceStatus, UserType, KYCStatus } from "../../src/types/enums";
import type { IPFSService } from "../../src/services/ipfs.service";

const mockIPFSService = {} as IPFSService;

function createInvoiceRepository(invoices: Map<string, Invoice>) {
  return {
    findOne: async (options: { where: { id: string } }) => {
      return invoices.get(options.where.id) || null;
    },
    findOneBy: async (options: { id?: string; invoiceNumber?: string }) => {
      if (options.id) {
        return invoices.get(options.id) || null;
      }
      return null;
    },
  } as any;
}

function createInvestmentRepository(investments: Map<string, Investment>) {
  return {
    count: async (options: { where: { invoiceId: string } }) => {
      return [...investments.values()].filter(
        (inv) => inv.invoiceId === options.where.invoiceId
      ).length;
    },
  } as any;
}

function createFakeDataSource(investments: Map<string, Investment>) {
  return {
    getRepository: jest.fn().mockImplementation((entity: any) => {
      if (entity === Investment) {
        return createInvestmentRepository(investments);
      }
      return {};
    }),
  } as any;
}

describe("Invoice analytics integration: seller authorization scoping", () => {
  let invoices: Map<string, Invoice>;
  let investments: Map<string, Investment>;
  let sellerA: User;
  let sellerB: User;
  let invoiceA: Invoice;
  let invoiceService: InvoiceService;

  beforeEach(() => {
    invoices = new Map();
    investments = new Map();

    sellerA = {
      id: "seller-a-id",
      stellarAddress: "GSELLERA123",
      email: "sellerA@test.com",
      userType: UserType.SELLER,
      kycStatus: KYCStatus.APPROVED,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as User;

    sellerB = {
      id: "seller-b-id",
      stellarAddress: "GSELLERB123",
      email: "sellerB@test.com",
      userType: UserType.SELLER,
      kycStatus: KYCStatus.APPROVED,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as User;

    invoiceA = {
      id: "invoice-a-id",
      sellerId: sellerA.id,
      invoiceNumber: "INV-A-ANALYTICS-001",
      customerName: "Customer A",
      amount: "1000.0000",
      discountRate: "5.00",
      netAmount: "950.0000",
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      status: InvoiceStatus.PUBLISHED,
      ipfsHash: null,
      riskScore: null,
      smartContractId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as Invoice;

    invoices.set(invoiceA.id, invoiceA);

    const investmentA = {
      id: "investment-a-id",
      invoiceId: invoiceA.id,
      investorId: sellerB.id,
      investmentAmount: "100.0000",
      expectedReturn: "105.0000",
      status: "pending" as any,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as Investment;

    investments.set(investmentA.id, investmentA);

    const invoiceRepository = createInvoiceRepository(invoices);
    const fakeDataSource = createFakeDataSource(investments);

    invoiceService = new InvoiceService({
      invoiceRepository,
      ipfsService: mockIPFSService,
      dataSource: fakeDataSource,
    });
  });

  it("returns 403 with error code forbidden when seller B requests analytics for seller A's invoice", async () => {
    await expect(
      invoiceService.getInvoiceAnalytics(invoiceA.id, sellerB.id),
    ).rejects.toMatchObject({
      code: "forbidden",
      statusCode: 403,
    });
  });

  it("returns 200 with analytics data when seller A requests analytics for their own invoice", async () => {
    const result = await invoiceService.getInvoiceAnalytics(invoiceA.id, sellerA.id);

    expect(result).toBeDefined();
    expect(result.invoiceId).toBe(invoiceA.id);
    expect(result.views).toBe(0);
    expect(result.clickThroughs).toBe(0);
    expect(result.investorInterest).toBe(1);
  });

  it("returns 404 for non-existent invoice", async () => {
    await expect(
      invoiceService.getInvoiceAnalytics("non-existent-id", sellerA.id),
    ).rejects.toMatchObject({
      code: "invoice_not_found",
      statusCode: 404,
    });
  });

  it("returns investorInterest of 0 when invoice has no investments", async () => {
    investments.clear();

    const result = await invoiceService.getInvoiceAnalytics(invoiceA.id, sellerA.id);

    expect(result.investorInterest).toBe(0);
  });
});
