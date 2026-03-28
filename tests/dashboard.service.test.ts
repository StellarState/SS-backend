import { DashboardService } from "../src/services/dashboard.service";
import { ServiceError } from "../src/utils/service-error";
import { Invoice } from "../src/models/Invoice.model";
import { Investment } from "../src/models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../src/types/enums";

describe("DashboardService", () => {
    let mockDashboardRepository: any;
    let dashboardService: DashboardService;

    beforeEach(() => {
        mockDashboardRepository = {
            getSellerMetrics: jest.fn(),
            getInvestorMetrics: jest.fn(),
        };

        dashboardService = new DashboardService({
            dashboardRepository: mockDashboardRepository,
        });
    });

    describe("getSellerDashboard", () => {
        it("should return seller metrics with status counts", async () => {
            const mockMetrics = {
                totalListings: 5,
                listingsByStatus: {
                    [InvoiceStatus.DRAFT]: 1,
                    [InvoiceStatus.PENDING]: 1,
                    [InvoiceStatus.PUBLISHED]: 1,
                    [InvoiceStatus.FUNDED]: 1,
                    [InvoiceStatus.SETTLED]: 1,
                    [InvoiceStatus.CANCELLED]: 0,
                },
                totalFundedVolume: "2000.0000",
                upcomingDueDates: [
                    {
                        invoiceId: "inv-1",
                        invoiceNumber: "INV-001",
                        dueDate: new Date("2024-12-31"),
                        amount: "1000.0000",
                        status: InvoiceStatus.FUNDED,
                    },
                ],
            };

            mockDashboardRepository.getSellerMetrics.mockResolvedValue(mockMetrics);

            const result = await dashboardService.getSellerDashboard("seller-123");

            expect(result).toEqual(mockMetrics);
            expect(mockDashboardRepository.getSellerMetrics).toHaveBeenCalledWith("seller-123");
        });

        it("should throw error when seller ID is missing", async () => {
            await expect(dashboardService.getSellerDashboard("")).rejects.toThrow(ServiceError);

            await expect(dashboardService.getSellerDashboard("")).rejects.toMatchObject({
                code: "invalid_seller_id",
                statusCode: 400,
            });
        });

        it("should calculate total funded volume correctly", async () => {
            const mockMetrics = {
                totalListings: 3,
                listingsByStatus: {
                    [InvoiceStatus.DRAFT]: 0,
                    [InvoiceStatus.PENDING]: 0,
                    [InvoiceStatus.PUBLISHED]: 0,
                    [InvoiceStatus.FUNDED]: 2,
                    [InvoiceStatus.SETTLED]: 1,
                    [InvoiceStatus.CANCELLED]: 0,
                },
                totalFundedVolume: "3000.0000", // 1000 + 1500 + 500
                upcomingDueDates: [],
            };

            mockDashboardRepository.getSellerMetrics.mockResolvedValue(mockMetrics);

            const result = await dashboardService.getSellerDashboard("seller-123");

            expect(result.totalFundedVolume).toBe("3000.0000");
        });

        it("should filter upcoming due dates within 30 days", async () => {
            const now = new Date();
            const in15Days = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000);
            const in45Days = new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000);

            const mockMetrics = {
                totalListings: 2,
                listingsByStatus: {
                    [InvoiceStatus.DRAFT]: 0,
                    [InvoiceStatus.PENDING]: 0,
                    [InvoiceStatus.PUBLISHED]: 0,
                    [InvoiceStatus.FUNDED]: 2,
                    [InvoiceStatus.SETTLED]: 0,
                    [InvoiceStatus.CANCELLED]: 0,
                },
                totalFundedVolume: "2000.0000",
                upcomingDueDates: [
                    {
                        invoiceId: "inv-1",
                        invoiceNumber: "INV-001",
                        dueDate: in15Days,
                        amount: "1000.0000",
                        status: InvoiceStatus.FUNDED,
                    },
                ],
            };

            mockDashboardRepository.getSellerMetrics.mockResolvedValue(mockMetrics);

            const result = await dashboardService.getSellerDashboard("seller-123");

            expect(result.upcomingDueDates).toHaveLength(1);
            expect(result.upcomingDueDates[0].dueDate).toEqual(in15Days);
        });
    });

    describe("getInvestorDashboard", () => {
        it("should return investor metrics with investment counts", async () => {
            const mockMetrics = {
                activeInvestments: 3,
                investmentsByStatus: {
                    [InvestmentStatus.PENDING]: 0,
                    [InvestmentStatus.CONFIRMED]: 2,
                    [InvestmentStatus.SETTLED]: 1,
                    [InvestmentStatus.CANCELLED]: 0,
                },
                expectedReturnSum: "300.0000",
                actualReturnSum: "100.0000",
                upcomingMaturities: [
                    {
                        investmentId: "inv-1",
                        invoiceNumber: "INV-001",
                        invoiceDueDate: new Date("2024-12-31"),
                        investmentAmount: "500.0000",
                        expectedReturn: "50.0000",
                        status: InvestmentStatus.CONFIRMED,
                    },
                ],
            };

            mockDashboardRepository.getInvestorMetrics.mockResolvedValue(mockMetrics);

            const result = await dashboardService.getInvestorDashboard("investor-123");

            expect(result).toEqual(mockMetrics);
            expect(mockDashboardRepository.getInvestorMetrics).toHaveBeenCalledWith("investor-123");
        });

        it("should throw error when investor ID is missing", async () => {
            await expect(dashboardService.getInvestorDashboard("")).rejects.toThrow(ServiceError);

            await expect(dashboardService.getInvestorDashboard("")).rejects.toMatchObject({
                code: "invalid_investor_id",
                statusCode: 400,
            });
        });

        it("should calculate expected and actual return sums", async () => {
            const mockMetrics = {
                activeInvestments: 2,
                investmentsByStatus: {
                    [InvestmentStatus.PENDING]: 0,
                    [InvestmentStatus.CONFIRMED]: 1,
                    [InvestmentStatus.SETTLED]: 1,
                    [InvestmentStatus.CANCELLED]: 0,
                },
                expectedReturnSum: "200.0000", // 100 + 100
                actualReturnSum: "150.0000", // 75 + 75
                upcomingMaturities: [],
            };

            mockDashboardRepository.getInvestorMetrics.mockResolvedValue(mockMetrics);

            const result = await dashboardService.getInvestorDashboard("investor-123");

            expect(result.expectedReturnSum).toBe("200.0000");
            expect(result.actualReturnSum).toBe("150.0000");
        });

        it("should include only confirmed and settled investments in upcoming maturities", async () => {
            const now = new Date();
            const in15Days = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000);

            const mockMetrics = {
                activeInvestments: 3,
                investmentsByStatus: {
                    [InvestmentStatus.PENDING]: 1,
                    [InvestmentStatus.CONFIRMED]: 1,
                    [InvestmentStatus.SETTLED]: 1,
                    [InvestmentStatus.CANCELLED]: 0,
                },
                expectedReturnSum: "300.0000",
                actualReturnSum: "100.0000",
                upcomingMaturities: [
                    {
                        investmentId: "inv-2",
                        invoiceNumber: "INV-002",
                        invoiceDueDate: in15Days,
                        investmentAmount: "500.0000",
                        expectedReturn: "50.0000",
                        status: InvestmentStatus.CONFIRMED,
                    },
                    {
                        investmentId: "inv-3",
                        invoiceNumber: "INV-003",
                        invoiceDueDate: in15Days,
                        investmentAmount: "500.0000",
                        expectedReturn: "50.0000",
                        status: InvestmentStatus.SETTLED,
                    },
                ],
            };

            mockDashboardRepository.getInvestorMetrics.mockResolvedValue(mockMetrics);

            const result = await dashboardService.getInvestorDashboard("investor-123");

            expect(result.upcomingMaturities).toHaveLength(2);
            expect(result.upcomingMaturities.every((m) => m.status !== InvestmentStatus.PENDING)).toBe(
                true,
            );
        });

        it("should handle zero actual returns for pending investments", async () => {
            const mockMetrics = {
                activeInvestments: 1,
                investmentsByStatus: {
                    [InvestmentStatus.PENDING]: 1,
                    [InvestmentStatus.CONFIRMED]: 0,
                    [InvestmentStatus.SETTLED]: 0,
                    [InvestmentStatus.CANCELLED]: 0,
                },
                expectedReturnSum: "100.0000",
                actualReturnSum: "0.0000",
                upcomingMaturities: [],
            };

            mockDashboardRepository.getInvestorMetrics.mockResolvedValue(mockMetrics);

            const result = await dashboardService.getInvestorDashboard("investor-123");

            expect(result.actualReturnSum).toBe("0.0000");
        });
    });
});
