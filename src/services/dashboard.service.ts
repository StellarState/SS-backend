import { DataSource } from "typeorm";
import { Decimal } from "decimal.js";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../types/enums";

/**
 * Dashboard APIs for seller and investor aggregates.
 *
 * Seller Dashboard: Visibility into listings and cash timing
 * Investor Dashboard: Portfolio and exposure views
 *
 * All queries respect soft deletes and tenant scoping (users only see their own data).
 * Uses QueryBuilder for efficient aggregation without N+1 queries.
 */

export interface SellerDashboardMetrics {
    totalInvoices: number;
    invoicesByStatus: {
        draft: number;
        pending: number;
        published: number;
        funded: number;
        settled: number;
        cancelled: number;
    };
    totalFundedVolume: string;
    totalSettledVolume: string;
    upcomingDueDates: Array<{
        invoiceId: string;
        invoiceNumber: string;
        amount: string;
        dueDate: Date;
        status: InvoiceStatus;
    }>;
}

export interface InvestorDashboardMetrics {
    activeInvestments: number;
    totalInvestedAmount: string;
    totalExpectedReturn: string;
    totalActualReturn: string;
    investmentsByStatus: {
        pending: number;
        confirmed: number;
        settled: number;
        cancelled: number;
    };
    upcomingMaturities: Array<{
        investmentId: string;
        invoiceNumber: string;
        investmentAmount: string;
        expectedReturn: string;
        dueDate: Date;
        status: InvestmentStatus;
    }>;
}

export class DashboardService {
    constructor(private readonly dataSource: DataSource) { }

    /**
     * Get seller dashboard aggregates.
     * Metrics computed:
     * - totalInvoices: Count of all non-deleted invoices for seller
     * - invoicesByStatus: Count breakdown by status
     * - totalFundedVolume: Sum of netAmount for FUNDED invoices
     * - totalSettledVolume: Sum of netAmount for SETTLED invoices
     * - upcomingDueDates: PUBLISHED/FUNDED invoices due within 30 days, sorted by dueDate
     */
    async getSellerDashboard(sellerId: string): Promise<SellerDashboardMetrics> {
        const invoiceRepository = this.dataSource.getRepository(Invoice);

        // 1. Count total invoices
        const totalInvoices = await invoiceRepository.count({
            where: { sellerId },
        });

        // 2. Count by status
        const statusCounts = await invoiceRepository
            .createQueryBuilder("invoice")
            .select("invoice.status", "status")
            .addSelect("COUNT(*)", "count")
            .where("invoice.seller_id = :sellerId", { sellerId })
            .andWhere("invoice.deleted_at IS NULL")
            .groupBy("invoice.status")
            .getRawMany();

        const invoicesByStatus = {
            draft: 0,
            pending: 0,
            published: 0,
            funded: 0,
            settled: 0,
            cancelled: 0,
        };

        statusCounts.forEach((row: Record<string, unknown>) => {
            invoicesByStatus[row.status as keyof typeof invoicesByStatus] = parseInt(row.count as string, 10);
        });

        // 3. Total funded volume
        const fundedVolume = await invoiceRepository
            .createQueryBuilder("invoice")
            .select("SUM(CAST(invoice.net_amount AS DECIMAL))", "total")
            .where("invoice.seller_id = :sellerId", { sellerId })
            .andWhere("invoice.status = :status", { status: InvoiceStatus.FUNDED })
            .andWhere("invoice.deleted_at IS NULL")
            .getRawOne();

        const totalFundedVolume = fundedVolume?.total ? new Decimal(fundedVolume.total).toFixed(4) : "0.0000";

        // 4. Total settled volume
        const settledVolume = await invoiceRepository
            .createQueryBuilder("invoice")
            .select("SUM(CAST(invoice.net_amount AS DECIMAL))", "total")
            .where("invoice.seller_id = :sellerId", { sellerId })
            .andWhere("invoice.status = :status", { status: InvoiceStatus.SETTLED })
            .andWhere("invoice.deleted_at IS NULL")
            .getRawOne();

        const totalSettledVolume = settledVolume?.total ? new Decimal(settledVolume.total).toFixed(4) : "0.0000";

        // 5. Upcoming due dates (next 30 days, PUBLISHED or FUNDED)
        const thirtyDaysFromNow = new Date();
        thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

        const upcomingDueDates = await invoiceRepository
            .createQueryBuilder("invoice")
            .select([
                "invoice.id",
                "invoice.invoiceNumber",
                "invoice.amount",
                "invoice.dueDate",
                "invoice.status",
            ])
            .where("invoice.seller_id = :sellerId", { sellerId })
            .andWhere("invoice.status IN (:...statuses)", {
                statuses: [InvoiceStatus.PUBLISHED, InvoiceStatus.FUNDED],
            })
            .andWhere("invoice.due_date <= :thirtyDaysFromNow", { thirtyDaysFromNow })
            .andWhere("invoice.due_date >= :today", { today: new Date() })
            .andWhere("invoice.deleted_at IS NULL")
            .orderBy("invoice.due_date", "ASC")
            .take(10)
            .getMany();

        return {
            totalInvoices,
            invoicesByStatus,
            totalFundedVolume,
            totalSettledVolume,
            upcomingDueDates: upcomingDueDates.map((inv) => ({
                invoiceId: inv.id,
                invoiceNumber: inv.invoiceNumber,
                amount: inv.amount,
                dueDate: inv.dueDate,
                status: inv.status,
            })),
        };
    }

    /**
     * Get investor dashboard aggregates.
     * Metrics computed:
     * - activeInvestments: Count of PENDING/CONFIRMED investments
     * - totalInvestedAmount: Sum of investmentAmount across all investments
     * - totalExpectedReturn: Sum of expectedReturn across all investments
     * - totalActualReturn: Sum of actualReturn for SETTLED investments
     * - investmentsByStatus: Count breakdown by status
     * - upcomingMaturities: CONFIRMED investments with invoices due within 30 days
     */
    async getInvestorDashboard(investorId: string): Promise<InvestorDashboardMetrics> {
        const investmentRepository = this.dataSource.getRepository(Investment);

        // 1. Count active investments
        const activeInvestments = await investmentRepository.count({
            where: [
                { investorId, status: InvestmentStatus.PENDING },
                { investorId, status: InvestmentStatus.CONFIRMED },
            ],
        });

        // 2. Total invested amount
        const investedAmount = await investmentRepository
            .createQueryBuilder("investment")
            .select("SUM(CAST(investment.investment_amount AS DECIMAL))", "total")
            .where("investment.investor_id = :investorId", { investorId })
            .andWhere("investment.deleted_at IS NULL")
            .getRawOne();

        const totalInvestedAmount = investedAmount?.total ? new Decimal(investedAmount.total).toFixed(4) : "0.0000";

        // 3. Total expected return
        const expectedReturn = await investmentRepository
            .createQueryBuilder("investment")
            .select("SUM(CAST(investment.expected_return AS DECIMAL))", "total")
            .where("investment.investor_id = :investorId", { investorId })
            .andWhere("investment.deleted_at IS NULL")
            .getRawOne();

        const totalExpectedReturn = expectedReturn?.total ? new Decimal(expectedReturn.total).toFixed(4) : "0.0000";

        // 4. Total actual return (settled only)
        const actualReturn = await investmentRepository
            .createQueryBuilder("investment")
            .select("SUM(CAST(investment.actual_return AS DECIMAL))", "total")
            .where("investment.investor_id = :investorId", { investorId })
            .andWhere("investment.status = :status", { status: InvestmentStatus.SETTLED })
            .andWhere("investment.deleted_at IS NULL")
            .getRawOne();

        const totalActualReturn = actualReturn?.total ? new Decimal(actualReturn.total).toFixed(4) : "0.0000";

        // 5. Count by status
        const statusCounts = await investmentRepository
            .createQueryBuilder("investment")
            .select("investment.status", "status")
            .addSelect("COUNT(*)", "count")
            .where("investment.investor_id = :investorId", { investorId })
            .andWhere("investment.deleted_at IS NULL")
            .groupBy("investment.status")
            .getRawMany();

        const investmentsByStatus = {
            pending: 0,
            confirmed: 0,
            settled: 0,
            cancelled: 0,
        };

        statusCounts.forEach((row: Record<string, unknown>) => {
            investmentsByStatus[row.status as keyof typeof investmentsByStatus] = parseInt(row.count as string, 10);
        });

        // 6. Upcoming maturities (CONFIRMED investments with invoices due within 30 days)
        const thirtyDaysFromNow = new Date();
        thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

        const upcomingMaturities = await investmentRepository
            .createQueryBuilder("investment")
            .leftJoinAndSelect("investment.invoice", "invoice")
            .select([
                "investment.id",
                "investment.investmentAmount",
                "investment.expectedReturn",
                "investment.status",
                "invoice.invoiceNumber",
                "invoice.dueDate",
            ])
            .where("investment.investor_id = :investorId", { investorId })
            .andWhere("investment.status = :status", { status: InvestmentStatus.CONFIRMED })
            .andWhere("invoice.due_date <= :thirtyDaysFromNow", { thirtyDaysFromNow })
            .andWhere("invoice.due_date >= :today", { today: new Date() })
            .andWhere("investment.deleted_at IS NULL")
            .orderBy("invoice.due_date", "ASC")
            .take(10)
            .getMany();

        return {
            activeInvestments,
            totalInvestedAmount,
            totalExpectedReturn,
            totalActualReturn,
            investmentsByStatus,
            upcomingMaturities: upcomingMaturities.map((inv) => ({
                investmentId: inv.id,
                invoiceNumber: inv.invoice.invoiceNumber,
                investmentAmount: inv.investmentAmount,
                expectedReturn: inv.expectedReturn,
                dueDate: inv.invoice.dueDate,
                status: inv.status,
            })),
        };
    }
}

export function createDashboardService(dataSource: DataSource): DashboardService {
    return new DashboardService(dataSource);
}
