import { SettlementService } from "../src/services/settlement.service";
import { ServiceError } from "../src/utils/service-error";
import { Invoice } from "../src/models/Invoice.model";
import { Investment } from "../src/models/Investment.model";
import { Transaction } from "../src/models/Transaction.model";
import { InvoiceStatus, InvestmentStatus, TransactionStatus, TransactionType } from "../src/types/enums";

describe("SettlementService", () => {
    let mockTransactionRunner: any;
    let settlementService: SettlementService;

    beforeEach(() => {
        mockTransactionRunner = {
            runInTransaction: jest.fn(),
        };

        settlementService = new SettlementService({
            transactionRunner: mockTransactionRunner,
        });
    });

    describe("settleInvoice", () => {
        const mockInvoice = {
            id: "invoice-123",
            sellerId: "seller-456",
            invoiceNumber: "INV-001",
            customerName: "Test Customer",
            amount: "1000.0000",
            discountRate: "5.00",
            netAmount: "950.0000",
            dueDate: new Date("2024-12-31"),
            ipfsHash: null,
            riskScore: null,
            status: InvoiceStatus.FUNDED,
            smartContractId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
        } as Invoice;

        const mockInvestments = [
            {
                id: "investment-1",
                invoiceId: "invoice-123",
                investorId: "investor-1",
                investmentAmount: "500.0000",
                expectedReturn: "50.0000",
                actualReturn: null,
                status: InvestmentStatus.CONFIRMED,
                transactionHash: null,
                stellarOperationIndex: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
            } as Investment,
            {
                id: "investment-2",
                invoiceId: "invoice-123",
                investorId: "investor-2",
                investmentAmount: "500.0000",
                expectedReturn: "50.0000",
                actualReturn: null,
                status: InvestmentStatus.CONFIRMED,
                transactionHash: null,
                stellarOperationIndex: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
            } as Investment,
        ];

        it("should successfully settle invoice with pro-rata distribution", async () => {
            const unitOfWork = {
                findInvoiceByIdForUpdate: jest.fn().mockResolvedValue(mockInvoice),
                findInvestmentsByInvoiceIdForUpdate: jest.fn().mockResolvedValue(mockInvestments),
                saveInvoice: jest.fn().mockImplementation((inv) => Promise.resolve(inv)),
                saveInvestment: jest.fn().mockImplementation((inv) => Promise.resolve(inv)),
                saveTransaction: jest.fn().mockImplementation((tx) => Promise.resolve({ ...tx, id: "tx-123" })),
                createTransaction: jest.fn().mockImplementation((input) => input),
            };

            mockTransactionRunner.runInTransaction.mockImplementation((cb) => cb(unitOfWork));

            const result = await settlementService.settleInvoice({
                invoiceId: "invoice-123",
                paidAmount: "1000.0000",
                stellarTxHash: "abc123def456",
            });

            expect(result.invoiceId).toBe("invoice-123");
            expect(result.invoiceStatus).toBe(InvoiceStatus.SETTLED);
            expect(result.investmentsSettled).toBe(2);
            expect(result.totalDistributed).toBe("1000.0000");
            expect(result.transactionId).toBe("tx-123");

            // Verify pro-rata distribution: each investor gets 500 (50% of 1000)
            const savedInvestments = unitOfWork.saveInvestment.mock.calls;
            expect(savedInvestments[0][0].actualReturn).toBe("500.0000");
            expect(savedInvestments[1][0].actualReturn).toBe("500.0000");
        });

        it("should handle rounding correctly with odd distribution", async () => {
            const investments = [
                {
                    ...mockInvestments[0],
                    investmentAmount: "333.3333",
                },
                {
                    ...mockInvestments[1],
                    investmentAmount: "666.6667",
                },
            ];

            const unitOfWork = {
                findInvoiceByIdForUpdate: jest.fn().mockResolvedValue(mockInvoice),
                findInvestmentsByInvoiceIdForUpdate: jest.fn().mockResolvedValue(investments),
                saveInvoice: jest.fn().mockImplementation((inv) => Promise.resolve(inv)),
                saveInvestment: jest.fn().mockImplementation((inv) => Promise.resolve(inv)),
                saveTransaction: jest.fn().mockImplementation((tx) => Promise.resolve({ ...tx, id: "tx-123" })),
                createTransaction: jest.fn().mockImplementation((input) => input),
            };

            mockTransactionRunner.runInTransaction.mockImplementation((cb) => cb(unitOfWork));

            const result = await settlementService.settleInvoice({
                invoiceId: "invoice-123",
                paidAmount: "1000.0000",
            });

            expect(result.totalDistributed).toBe("1000.0000");

            // Last investor should get remainder to ensure exact distribution
            const savedInvestments = unitOfWork.saveInvestment.mock.calls;
            const firstReturn = BigInt(savedInvestments[0][0].actualReturn.replace(".", ""));
            const secondReturn = BigInt(savedInvestments[1][0].actualReturn.replace(".", ""));
            const total = firstReturn + secondReturn;

            expect(total).toBe(BigInt(10000000)); // 1000.0000 normalized
        });

        it("should throw error when invoice not found", async () => {
            const unitOfWork = {
                findInvoiceByIdForUpdate: jest.fn().mockResolvedValue(null),
            };

            mockTransactionRunner.runInTransaction.mockImplementation((cb) => cb(unitOfWork));

            await expect(
                settlementService.settleInvoice({
                    invoiceId: "nonexistent",
                    paidAmount: "1000.0000",
                }),
            ).rejects.toThrow(ServiceError);

            await expect(
                settlementService.settleInvoice({
                    invoiceId: "nonexistent",
                    paidAmount: "1000.0000",
                }),
            ).rejects.toMatchObject({
                code: "invoice_not_found",
                statusCode: 404,
            });
        });

        it("should throw error when invoice is not in FUNDED status", async () => {
            const draftInvoice = { ...mockInvoice, status: InvoiceStatus.DRAFT };

            const unitOfWork = {
                findInvoiceByIdForUpdate: jest.fn().mockResolvedValue(draftInvoice),
            };

            mockTransactionRunner.runInTransaction.mockImplementation((cb) => cb(unitOfWork));

            await expect(
                settlementService.settleInvoice({
                    invoiceId: "invoice-123",
                    paidAmount: "1000.0000",
                }),
            ).rejects.toMatchObject({
                code: "invalid_invoice_state",
                statusCode: 400,
            });
        });

        it("should throw error when investments are not all CONFIRMED", async () => {
            const mixedInvestments = [
                mockInvestments[0],
                { ...mockInvestments[1], status: InvestmentStatus.PENDING },
            ];

            const unitOfWork = {
                findInvoiceByIdForUpdate: jest.fn().mockResolvedValue(mockInvoice),
                findInvestmentsByInvoiceIdForUpdate: jest.fn().mockResolvedValue(mixedInvestments),
            };

            mockTransactionRunner.runInTransaction.mockImplementation((cb) => cb(unitOfWork));

            await expect(
                settlementService.settleInvoice({
                    invoiceId: "invoice-123",
                    paidAmount: "1000.0000",
                }),
            ).rejects.toMatchObject({
                code: "invalid_investment_state",
                statusCode: 400,
            });
        });

        it("should throw error when no investments exist", async () => {
            const unitOfWork = {
                findInvoiceByIdForUpdate: jest.fn().mockResolvedValue(mockInvoice),
                findInvestmentsByInvoiceIdForUpdate: jest.fn().mockResolvedValue([]),
            };

            mockTransactionRunner.runInTransaction.mockImplementation((cb) => cb(unitOfWork));

            await expect(
                settlementService.settleInvoice({
                    invoiceId: "invoice-123",
                    paidAmount: "1000.0000",
                }),
            ).rejects.toMatchObject({
                code: "no_investments",
                statusCode: 400,
            });
        });

        it("should be idempotent - calling settlement twice should not double-pay", async () => {
            const settledInvoice = { ...mockInvoice, status: InvoiceStatus.SETTLED };
            const settledInvestments = mockInvestments.map((inv) => ({
                ...inv,
                status: InvestmentStatus.SETTLED,
                actualReturn: "500.0000",
            }));

            const unitOfWork = {
                findInvoiceByIdForUpdate: jest.fn().mockResolvedValue(settledInvoice),
            };

            mockTransactionRunner.runInTransaction.mockImplementation((cb) => cb(unitOfWork));

            await expect(
                settlementService.settleInvoice({
                    invoiceId: "invoice-123",
                    paidAmount: "1000.0000",
                }),
            ).rejects.toMatchObject({
                code: "invalid_invoice_state",
                statusCode: 400,
            });
        });

        it("should create settlement transaction record for audit trail", async () => {
            const unitOfWork = {
                findInvoiceByIdForUpdate: jest.fn().mockResolvedValue(mockInvoice),
                findInvestmentsByInvoiceIdForUpdate: jest.fn().mockResolvedValue(mockInvestments),
                saveInvoice: jest.fn().mockImplementation((inv) => Promise.resolve(inv)),
                saveInvestment: jest.fn().mockImplementation((inv) => Promise.resolve(inv)),
                saveTransaction: jest.fn().mockImplementation((tx) => Promise.resolve({ ...tx, id: "tx-123" })),
                createTransaction: jest.fn().mockImplementation((input) => input),
            };

            mockTransactionRunner.runInTransaction.mockImplementation((cb) => cb(unitOfWork));

            await settlementService.settleInvoice({
                invoiceId: "invoice-123",
                paidAmount: "1000.0000",
                stellarTxHash: "abc123def456",
            });

            const createTransactionCall = unitOfWork.createTransaction.mock.calls[0][0];
            expect(createTransactionCall.type).toBe(TransactionType.PAYMENT);
            expect(createTransactionCall.status).toBe(TransactionStatus.COMPLETED);
            expect(createTransactionCall.stellarTxHash).toBe("abc123def456");
            expect(createTransactionCall.amount).toBe("1000.0000");
        });
    });
});
