import { DataSource, Repository } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";

export interface SellerDashboardMetrics {
    totalListings: number;
    listingsByStatus: Record<InvoiceStatus, number>;
    totalFundedVolume: string;
    upcomingDueDates: Array<{
        invoiceId: string;
        invoiceNumber: string;
        dueDate: Date;
        amount: string;
        status: InvoiceStatus;
    }>;
}

export interface InvestorDashboardMetrics {
    activeInvestments: number;
    investmentsByStatus: Record<InvestmentStatus, number>;
    expectedReturnSum: string;
    actualReturnSum: string;
    upcomingMaturities: Array<{
        investmentId: string;
        invoiceNumber: string;
        invoiceDueDate: Date;
        investmentAmount: string;
        expectedReturn: string;
        status: InvestmentStatus;
    }>;
}

interface DashboardRepositoryContract {
    getSellerMetrics(sellerId: string): Promise<SellerDashboardMetrics>;
    getInvestorMetrics(investorId: string): Promise<InvestorDashboardMetrics>;
}

interface DashboardServiceDependencies {
    dashboardRepository: DashboardRepositoryContract;
}

export class DashboardService {
    constructor(private readonly dependencies: DashboardServiceDependencies) { }

    async getSellerDashboard(sellerId: string): Promise<SellerDashboardMetrics> {
        if (!sellerId) {
            throw new ServiceError("invalid_seller_id", "Seller ID is required.", 400);
        }

        return this.dependencies.dashboardRepository.getSellerMetrics(sellerId);
    }

    async getInvestorDashboard(investorId: string): Promise<InvestorDashboardMetrics> {
        if (!investorId) {
            throw new ServiceError("invalid_investor_id", "Investor ID is required.", 400);
        }

        return this.dependencies.dashboardRepository.getInvestorMetrics(investorId);
    }
}

class TypeOrmDashboardRepository implements DashboardRepositoryContract {
    constructor(
        private readonly invoiceRepository: Repository<Invoice>,
        private readonly investmentRepository: Repository<Investment>,
    ) { }

    async getSellerMetrics(sellerId: string): Promise<SellerDashboardMetrics> {
        // Get all invoices for seller (excluding soft deletes)
        const invoices = await this.invoiceRepository.find({
            where: { sellerId, deletedAt: null },
            order: { dueDate: "ASC" },
        });

        // Count by status
        const listingsByStatus: Record<InvoiceStatus, number> = {
            [InvoiceStatus.DRAFT]: 0,
            [InvoiceStatus.PENDING]: 0,
            [InvoiceStatus.PUBLISHED]: 0,
            [InvoiceStatus.FUNDED]: 0,
            [InvoiceStatus.SETTLED]: 0,
            [InvoiceStatus.CANCELLED]: 0,
        };

        let totalFundedVolume = BigInt(0);

        for (const invoice of invoices) {
            listingsByStatus[invoice.status] += 1;

            if (invoice.status === InvoiceStatus.FUNDED || invoice.status === InvoiceStatus.SETTLED) {
                totalFundedVolume += BigInt(this.normalizeAmount(invoice.netAmount));
            }
        }

        // Get upcoming due dates (next 30 days, funded or settled only)
        const now = new Date();
        const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        const upcomingDueDates = invoices
            .filter(
                (inv) =>
                    (inv.status === InvoiceStatus.FUNDED || inv.status === InvoiceStatus.SETTLED) &&
                    inv.dueDate >= now &&
                    inv.dueDate <= thirtyDaysFromNow,
            )
            .map((inv) => ({
                invoiceId: inv.id,
                invoiceNumber: inv.invoiceNumber,
                dueDate: inv.dueDate,
                amount: inv.netAmount,
                status: inv.status,
            }));

        return {
            totalListings: invoices.length,
            listingsByStatus,
            totalFundedVolume: this.denormalizeAmount(totalFundedVolume),
            upcomingDueDates,
        };
    }

    async getInvestorMetrics(investorId: string): Promise<InvestorDashboardMetrics> {
        // Get all investments for investor (excluding soft deletes)
        const investments = await this.investmentRepository.find({
            where: { investorId, deletedAt: null },
            relations: ["invoice"],
            order: { createdAt: "ASC" },
        });

        // Count by status
        const investmentsByStatus: Record<InvestmentStatus, number> = {
            [InvestmentStatus.PENDING]: 0,
            [InvestmentStatus.CONFIRMED]: 0,
            [InvestmentStatus.SETTLED]: 0,
            [InvestmentStatus.CANCELLED]: 0,
        };

        let expectedReturnSum = BigInt(0);
        let actualReturnSum = BigInt(0);

        for (const investment of investments) {
            investmentsByStatus[investment.status] += 1;
            expectedReturnSum += BigInt(this.normalizeAmount(investment.expectedReturn));

            if (investment.actualReturn) {
                actualReturnSum += BigInt(this.normalizeAmount(investment.actualReturn));
            }
        }

        // Get upcoming maturities (next 30 days, confirmed or settled only)
        const now = new Date();
        const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        const upcomingMaturities = investments
            .filter(
                (inv) =>
                    (inv.status === InvestmentStatus.CONFIRMED || inv.status === InvestmentStatus.SETTLED) &&
                    inv.invoice &&
                    inv.invoice.dueDate >= now &&
                    inv.invoice.dueDate <= thirtyDaysFromNow,
            )
            .map((inv) => ({
                investmentId: inv.id,
                invoiceNumber: inv.invoice!.invoiceNumber,
                invoiceDueDate: inv.invoice!.dueDate,
                investmentAmount: inv.investmentAmount,
                expectedReturn: inv.expectedReturn,
                status: inv.status,
            }));

        return {
            activeInvestments: investments.length,
            investmentsByStatus,
            expectedReturnSum: this.denormalizeAmount(expectedReturnSum),
            actualReturnSum: this.denormalizeAmount(actualReturnSum),
            upcomingMaturities,
        };
    }

    private normalizeAmount(amount: string): string {
        const normalized = amount.trim();
        const [whole, fraction = ""] = normalized.split(".");
        const paddedFraction = `${fraction}${"0".repeat(4)}`.slice(0, 4);
        return `${whole}${paddedFraction}`;
    }

    private denormalizeAmount(value: bigint): string {
        const str = value.toString().padStart(5, "0");
        const whole = str.slice(0, -4);
        const fraction = str.slice(-4);
        return `${whole}.${fraction}`;
    }
}

export function createDashboardService(dataSource: DataSource): DashboardService {
    const invoiceRepository = dataSource.getRepository(Invoice);
    const investmentRepository = dataSource.getRepository(Investment);

    return new DashboardService({
        dashboardRepository: new TypeOrmDashboardRepository(invoiceRepository, investmentRepository),
    });
}
