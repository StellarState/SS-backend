import { DataSource, EntityManager, SelectQueryBuilder } from "typeorm";
import { SettlementService } from "../src/services/settlement.service";
import { Invoice } from "../src/models/Invoice.model";
import { Investment } from "../src/models/Investment.model";
import { Transaction } from "../src/models/Transaction.model";
import { InvoiceStatus, InvestmentStatus, TransactionType, TransactionStatus } from "../src/types/enums";
import { ServiceError } from "../src/utils/service-error";

describe("SettlementService", () => {
    let mockDataSource: jest.Mocked<DataSource>;
    let mockEntityManager: jest.Mocked<EntityManager>;
    let mockQueryBuilder: jest.Mocked<SelectQueryBuilder<Invoice>>;
    let settlementService: SettlementService;

    beforeEach(() => {
        mockQueryBuilder = {
            setLock: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            getOne: jest.fn(),
        } as any;

        mockEntityManager = {
            createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
        } as any;

        mockDataSource = {
            transaction: jest.fn().mockImplementation((cb) => cb(mockEntityManager)),
        } as any;

        settlementService = new SettlementService(mockDataSource);
    });

    const getMockInvoice = () => ({
        id: "invoice-1",
        sellerId: "seller-1",
        amount: "1000.0000",
        netAmount: "950.0000",
        status: InvoiceStatus.FUNDED,
    } as Invoice);

    const getMockInvestments = () => [
        {
            id: "inv-1",
            invoiceId: "invoice-1",
            investorId: "investor-1",
            investmentAmount: "475.0000",
            expectedReturn: "500.0000",
            status: InvestmentStatus.CONFIRMED,
            createdAt: new Date("2024-01-01"),
        } as Investment,
        {
            id: "inv-2",
            invoiceId: "invoice-1",
            investorId: "investor-2",
            investmentAmount: "475.0000",
            expectedReturn: "500.0000",
            status: InvestmentStatus.CONFIRMED,
            createdAt: new Date("2024-01-02"),
        } as Investment,
    ];

    it("should settle invoice and distribute pro-rata returns to 2 investors", async () => {
        const mockInvoice = getMockInvoice();
        const mockInvestments = getMockInvestments();

        mockQueryBuilder.getOne.mockResolvedValue(mockInvoice);
        mockEntityManager.find.mockResolvedValue(mockInvestments);
        mockEntityManager.create.mockImplementation((entity: any, data: any) => data);
        mockEntityManager.save.mockImplementation((entity: any, data: any) => Promise.resolve(data));

        const result = await settlementService.settleInvoice({
            invoiceId: "invoice-1",
            sellerId: "seller-1",
            paidAmount: "1000.0000",
        });

        expect(result.invoiceStatus).toBe(InvoiceStatus.SETTLED);
        expect(result.investmentsSettled).toBe(2);
        expect(result.totalDistributed).toBe("1000.0000");

        // Verify both investments were saved with actualReturn
        const saveCalls = mockEntityManager.save.mock.calls;
        const investmentSaves = saveCalls.filter((call) => call[0] === Investment);
        expect(investmentSaves.length).toBe(2);

        // Each investor should get 500 (1000 * 475/950)
        expect((investmentSaves[0][1] as any).actualReturn).toBe("500.0000");
        expect((investmentSaves[1][1] as any).actualReturn).toBe("500.0000");
    });

    it("should handle rounding: last investor absorbs difference", async () => {
        const mockInvoice = getMockInvoice();
        const mockInvestments = [
            {
                id: "inv-1",
                invoiceId: "invoice-1",
                investorId: "investor-1",
                investmentAmount: "333.3333",
                expectedReturn: "350.0000",
                status: InvestmentStatus.CONFIRMED,
                createdAt: new Date("2024-01-01"),
            } as Investment,
            {
                id: "inv-2",
                invoiceId: "invoice-1",
                investorId: "investor-2",
                investmentAmount: "333.3333",
                expectedReturn: "350.0000",
                status: InvestmentStatus.CONFIRMED,
                createdAt: new Date("2024-01-02"),
            } as Investment,
            {
                id: "inv-3",
                invoiceId: "invoice-1",
                investorId: "investor-3",
                investmentAmount: "283.3334",
                expectedReturn: "300.0000",
                status: InvestmentStatus.CONFIRMED,
                createdAt: new Date("2024-01-03"),
            } as Investment,
        ];

        mockQueryBuilder.getOne.mockResolvedValue(mockInvoice);
        mockEntityManager.find.mockResolvedValue(mockInvestments);
        mockEntityManager.create.mockImplementation((entity: any, data: any) => data);
        mockEntityManager.save.mockImplementation((entity: any, data: any) => Promise.resolve(data));

        const result = await settlementService.settleInvoice({
            invoiceId: "invoice-1",
            sellerId: "seller-1",
            paidAmount: "1000.0000",
        });

        expect(result.totalDistributed).toBe("1000.0000");

        const saveCalls = mockEntityManager.save.mock.calls;
        const investmentSaves = saveCalls.filter((call) => call[0] === Investment);

        // Last investor absorbs rounding
        const lastInvestorReturn = (investmentSaves[2][1] as any).actualReturn;
        expect(lastInvestorReturn).toBeDefined();
    });

    it("should be idempotent: calling settlement twice returns same result", async () => {
        const mockInvoice = getMockInvoice();
        mockInvoice.status = InvoiceStatus.SETTLED;

        const mockInvestments = getMockInvestments();
        mockInvestments.forEach((inv) => {
            inv.status = InvestmentStatus.SETTLED;
            inv.actualReturn = "500.0000";
        });

        mockQueryBuilder.getOne.mockResolvedValue(mockInvoice);
        mockEntityManager.find.mockResolvedValue(mockInvestments);

        const result = await settlementService.settleInvoice({
            invoiceId: "invoice-1",
            sellerId: "seller-1",
            paidAmount: "1000.0000",
        });

        expect(result.invoiceStatus).toBe(InvoiceStatus.SETTLED);
        expect(result.investmentsSettled).toBe(2);
        expect(result.totalDistributed).toBe("1000.0000");
    });

    it("should reject settlement if invoice not FUNDED", async () => {
        const mockInvoice = getMockInvoice();
        mockInvoice.status = InvoiceStatus.PUBLISHED;

        mockQueryBuilder.getOne.mockResolvedValue(mockInvoice);

        await expect(
            settlementService.settleInvoice({
                invoiceId: "invoice-1",
                sellerId: "seller-1",
                paidAmount: "1000.0000",
            }),
        ).rejects.toThrow(
            new ServiceError(
                "INVALID_INVOICE_STATE",
                "Cannot settle invoice in published status. Only FUNDED invoices can be settled.",
                400,
            ),
        );
    });

    it("should reject settlement if seller does not own invoice", async () => {
        const mockInvoice = getMockInvoice();
        mockQueryBuilder.getOne.mockResolvedValue(mockInvoice);

        await expect(
            settlementService.settleInvoice({
                invoiceId: "invoice-1",
                sellerId: "seller-2",
                paidAmount: "1000.0000",
            }),
        ).rejects.toThrow(
            new ServiceError(
                "UNAUTHORIZED_SETTLEMENT",
                "Only the invoice seller can settle",
                403,
            ),
        );
    });

    it("should reject invalid paid amount", async () => {
        await expect(
            settlementService.settleInvoice({
                invoiceId: "invoice-1",
                sellerId: "seller-1",
                paidAmount: "-100.0000",
            }),
        ).rejects.toThrow(
            new ServiceError(
                "INVALID_SETTLEMENT_AMOUNT",
                "Paid amount must be greater than zero",
                400,
            ),
        );
    });

    it("should create PAYMENT transaction for audit trail", async () => {
        const mockInvoice = getMockInvoice();
        const mockInvestments = getMockInvestments();

        mockQueryBuilder.getOne.mockResolvedValue(mockInvoice);
        mockEntityManager.find.mockResolvedValue(mockInvestments);
        mockEntityManager.create.mockImplementation((entity: any, data: any) => data);
        mockEntityManager.save.mockImplementation((entity: any, data: any) => Promise.resolve(data));

        await settlementService.settleInvoice({
            invoiceId: "invoice-1",
            sellerId: "seller-1",
            paidAmount: "1000.0000",
            stellarTxHash: "abc123",
        });

        const saveCalls = mockEntityManager.save.mock.calls;
        const transactionSaves = saveCalls.filter((call) => call[0] === Transaction);

        expect(transactionSaves.length).toBe(1);
        expect((transactionSaves[0][1] as any).type).toBe(TransactionType.PAYMENT);
        expect((transactionSaves[0][1] as any).amount).toBe("1000.0000");
        expect((transactionSaves[0][1] as any).stellarTxHash).toBe("abc123");
    });
});
