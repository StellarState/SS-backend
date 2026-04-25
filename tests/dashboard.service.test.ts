import { DataSource, Repository, SelectQueryBuilder } from "typeorm";
import { DashboardService } from "../src/services/dashboard.service";
import { Invoice } from "../src/models/Invoice.model";
import { Investment } from "../src/models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../src/types/enums";

describe("DashboardService", () => {
    let mockDataSource: jest.Mocked<DataSource>;
    let mockInvoiceRepository: jest.Mocked<Repository<Invoice>>;
    let mockInvestmentRepository: jest.Mocked<Repository<Investment>>;
    let dashboardService: DashboardService;

    beforeEach(() => {
        mockInvoiceRepository = {
            count: jest.fn(),
            createQueryBuilder: jest.fn(),
        } as any;

        mockInvestmentRepository = {
            count: jest.fn(),
            createQueryBuilder: jest.fn(),
        } as any;

        mockDataSource = {
            getRepository: jest.fn((entity) => {
                if (entity === Invoice) return mockInvoiceRepository;
                if (entity === Investment) return mockInvestmentRepository;
            }),
        } as any;

        dashboardService = new DashboardService(mockDataSource);
    });

    describe("getSellerDashboard", () => {
        it("should aggregate seller metrics correctly", async () => {
            const sellerId = "seller-1";

            mockInvoiceRepository.count.mockResolvedValue(5);

            const mockQueryBuilder = {
                select: jest.fn().mockReturnThis(),
                addSelect: jest.fn().mockReturnThis(),
                where: jest.fn().mockReturnThis(),
                andWhere: jest.fn().mockReturnThis(),
                groupBy: jest.fn().mockReturnThis(),
                getRawMany: jest.fn().mockResolvedValue([
                    { status: InvoiceStatus.DRAFT, count: "1" },
                    { status: InvoiceStatus.PUBLISHED, count: "2" },
                    { status: InvoiceStatus.FUNDED, count: "1" },
                    { status: InvoiceStatus.SETTLED, count: "1" },
                ]),
                getRawOne: jest.fn(),
                orderBy: jest.fn().mockReturnThis(),
                take: jest.fn().mockReturnThis(),
                getMany: jest.fn().mockResolvedValue([]),
            } as any;

            mockInvoiceRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

            // Mock funded volume query
            mockQueryBuilder.getRawOne.mockResolvedValueOnce({ total: "5000.0000" });
            // Mock settled volume query
            mockQueryBuilder.getRawOne.mockResolvedValueOnce({ total: "3000.0000" });

            const result = await dashboardService.getSellerDashboard(sellerId);

            expect(result.totalInvoices).toBe(5);
            expect(result.invoicesByStatus.draft).toBe(1);
            expect(result.invoicesByStatus.published).toBe(2);
            expect(result.invoicesByStatus.funded).toBe(1);
            expect(result.invoicesByStatus.settled).toBe(1);
            expect(result.totalFundedVolume).toBe("5000.0000");
            expect(result.totalSettledVolume).toBe("3000.0000");
            expect(result.upcomingDueDates).toEqual([]);
        });

        it("should return upcoming due dates within 30 days", async () => {
            const sellerId = "seller-1";
            const today = new Date();
            const in15Days = new Date(today.getTime() + 15 * 24 * 60 * 60 * 1000);

            mockInvoiceRepository.count.mockResolvedValue(2);

            const mockQueryBuilder = {
                select: jest.fn().mockReturnThis(),
                addSelect: jest.fn().mockReturnThis(),
                where: jest.fn().mockReturnThis(),
                andWhere: jest.fn().mockReturnThis(),
                groupBy: jest.fn().mockReturnThis(),
                getRawMany: jest.fn().mockResolvedValue([
                    { status: InvoiceStatus.PUBLISHED, count: "2" },
                ]),
                getRawOne: jest.fn().mockResolvedValue(null),
                orderBy: jest.fn().mockReturnThis(),
                take: jest.fn().mockReturnThis(),
                getMany: jest.fn().mockResolvedValue([
                    {
                        id: "inv-1",
                        invoiceNumber: "INV-001",
                        amount: "1000.0000",
                        dueDate: in15Days,
                        status: InvoiceStatus.PUBLISHED,
                    },
                ]),
            } as any;

            mockInvoiceRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

            const result = await dashboardService.getSellerDashboard(sellerId);

            expect(result.upcomingDueDates.length).toBe(1);
            expect(result.upcomingDueDates[0].invoiceNumber).toBe("INV-001");
        });
    });

    describe("getInvestorDashboard", () => {
        it("should aggregate investor metrics correctly", async () => {
            const investorId = "investor-1";

            mockInvestmentRepository.count.mockResolvedValue(3);

            const mockQueryBuilder = {
                select: jest.fn().mockReturnThis(),
                addSelect: jest.fn().mockReturnThis(),
                where: jest.fn().mockReturnThis(),
                andWhere: jest.fn().mockReturnThis(),
                groupBy: jest.fn().mockReturnThis(),
                getRawMany: jest.fn().mockResolvedValue([
                    { status: InvestmentStatus.PENDING, count: "1" },
                    { status: InvestmentStatus.CONFIRMED, count: "1" },
                    { status: InvestmentStatus.SETTLED, count: "1" },
                ]),
                getRawOne: jest.fn(),
                leftJoinAndSelect: jest.fn().mockReturnThis(),
                orderBy: jest.fn().mockReturnThis(),
                take: jest.fn().mockReturnThis(),
                getMany: jest.fn().mockResolvedValue([]),
            } as any;

            mockInvestmentRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

            // Mock invested amount query
            mockQueryBuilder.getRawOne.mockResolvedValueOnce({ total: "1000.0000" });
            // Mock expected return query
            mockQueryBuilder.getRawOne.mockResolvedValueOnce({ total: "1050.0000" });
            // Mock actual return query
            mockQueryBuilder.getRawOne.mockResolvedValueOnce({ total: "350.0000" });

            const result = await dashboardService.getInvestorDashboard(investorId);

            expect(result.activeInvestments).toBe(3);
            expect(result.totalInvestedAmount).toBe("1000.0000");
            expect(result.totalExpectedReturn).toBe("1050.0000");
            expect(result.totalActualReturn).toBe("350.0000");
            expect(result.investmentsByStatus.pending).toBe(1);
            expect(result.investmentsByStatus.confirmed).toBe(1);
            expect(result.investmentsByStatus.settled).toBe(1);
            expect(result.upcomingMaturities).toEqual([]);
        });

        it("should return upcoming maturities for CONFIRMED investments", async () => {
            const investorId = "investor-1";
            const today = new Date();
            const in20Days = new Date(today.getTime() + 20 * 24 * 60 * 60 * 1000);

            mockInvestmentRepository.count.mockResolvedValue(1);

            const mockQueryBuilder = {
                select: jest.fn().mockReturnThis(),
                addSelect: jest.fn().mockReturnThis(),
                where: jest.fn().mockReturnThis(),
                andWhere: jest.fn().mockReturnThis(),
                groupBy: jest.fn().mockReturnThis(),
                getRawMany: jest.fn().mockResolvedValue([
                    { status: InvestmentStatus.CONFIRMED, count: "1" },
                ]),
                getRawOne: jest.fn().mockResolvedValue(null),
                leftJoinAndSelect: jest.fn().mockReturnThis(),
                orderBy: jest.fn().mockReturnThis(),
                take: jest.fn().mockReturnThis(),
                getMany: jest.fn().mockResolvedValue([
                    {
                        id: "inv-1",
                        investmentAmount: "500.0000",
                        expectedReturn: "525.0000",
                        status: InvestmentStatus.CONFIRMED,
                        invoice: {
                            invoiceNumber: "INV-001",
                            dueDate: in20Days,
                        },
                    },
                ]),
            } as any;

            mockInvestmentRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

            const result = await dashboardService.getInvestorDashboard(investorId);

            expect(result.upcomingMaturities.length).toBe(1);
            expect(result.upcomingMaturities[0].invoiceNumber).toBe("INV-001");
            expect(result.upcomingMaturities[0].investmentAmount).toBe("500.0000");
        });

        it("should handle zero metrics gracefully", async () => {
            const investorId = "investor-1";

            mockInvestmentRepository.count.mockResolvedValue(0);

            const mockQueryBuilder = {
                select: jest.fn().mockReturnThis(),
                addSelect: jest.fn().mockReturnThis(),
                where: jest.fn().mockReturnThis(),
                andWhere: jest.fn().mockReturnThis(),
                groupBy: jest.fn().mockReturnThis(),
                getRawMany: jest.fn().mockResolvedValue([]),
                getRawOne: jest.fn().mockResolvedValue(null),
                leftJoinAndSelect: jest.fn().mockReturnThis(),
                orderBy: jest.fn().mockReturnThis(),
                take: jest.fn().mockReturnThis(),
                getMany: jest.fn().mockResolvedValue([]),
            } as any;

            mockInvestmentRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

            const result = await dashboardService.getInvestorDashboard(investorId);

            expect(result.activeInvestments).toBe(0);
            expect(result.totalInvestedAmount).toBe("0.0000");
            expect(result.totalExpectedReturn).toBe("0.0000");
            expect(result.totalActualReturn).toBe("0.0000");
        });
    });
});
