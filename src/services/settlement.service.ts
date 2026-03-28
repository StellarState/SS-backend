import { DataSource, Repository } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { Transaction } from "../models/Transaction.model";
import { InvoiceStatus, InvestmentStatus, TransactionStatus, TransactionType } from "../types/enums";
import { ServiceError } from "../utils/service-error";

export interface SettlementInput {
    invoiceId: string;
    paidAmount: string;
    stellarTxHash?: string;
    settledAt?: Date;
}

export interface SettlementResult {
    invoiceId: string;
    invoiceStatus: InvoiceStatus;
    investmentsSettled: number;
    totalDistributed: string;
    transactionId: string;
}

interface SettlementUnitOfWork {
    findInvoiceByIdForUpdate(invoiceId: string): Promise<Invoice | null>;
    findInvestmentsByInvoiceIdForUpdate(invoiceId: string): Promise<Investment[]>;
    saveInvoice(invoice: Invoice): Promise<Invoice>;
    saveInvestment(investment: Investment): Promise<Investment>;
    saveTransaction(transaction: Transaction): Promise<Transaction>;
    createTransaction(input: Partial<Transaction>): Transaction;
}

interface SettlementTransactionRunner {
    runInTransaction<T>(callback: (unitOfWork: SettlementUnitOfWork) => Promise<T>): Promise<T>;
}

interface SettlementServiceDependencies {
    transactionRunner: SettlementTransactionRunner;
}

/**
 * Settlement Service - MVP Bridge
 *
 * This service implements settlement that transitions invoices from funded → settled
 * and investments from confirmed → settled with actual_return populated.
 *
 * Pro-rata distribution formula:
 * For each investor: actual_return = (paidAmount * investmentAmount) / totalInvestedAmount
 *
 * This is an MVP implementation until on-chain settlement via Soroban events is fully wired.
 * Authorization: Currently accepts authenticated admin/seller endpoints (to be enforced at controller level).
 */
export class SettlementService {
    constructor(private readonly dependencies: SettlementServiceDependencies) { }

    async settleInvoice(input: SettlementInput): Promise<SettlementResult> {
        return this.dependencies.transactionRunner.runInTransaction(async (unitOfWork) => {
            const invoice = await unitOfWork.findInvoiceByIdForUpdate(input.invoiceId);

            if (!invoice) {
                throw new ServiceError("invoice_not_found", "Invoice not found.", 404);
            }

            // Validate invoice state transition: funded → settled
            if (invoice.status !== InvoiceStatus.FUNDED) {
                throw new ServiceError(
                    "invalid_invoice_state",
                    `Invoice must be in FUNDED status to settle. Current status: ${invoice.status}`,
                    400,
                );
            }

            const investments = await unitOfWork.findInvestmentsByInvoiceIdForUpdate(invoice.id);

            // Validate all investments are in confirmed state
            const unconfirmedInvestments = investments.filter(
                (inv) => inv.status !== InvestmentStatus.CONFIRMED,
            );

            if (unconfirmedInvestments.length > 0) {
                throw new ServiceError(
                    "invalid_investment_state",
                    `All investments must be CONFIRMED to settle. Found ${unconfirmedInvestments.length} non-confirmed investments.`,
                    400,
                );
            }

            if (investments.length === 0) {
                throw new ServiceError(
                    "no_investments",
                    "Cannot settle invoice with no confirmed investments.",
                    400,
                );
            }

            // Calculate pro-rata distribution
            const paidAmount = BigInt(this.normalizeAmount(input.paidAmount));
            const totalInvested = investments.reduce(
                (sum, inv) => sum + BigInt(this.normalizeAmount(inv.investmentAmount)),
                BigInt(0),
            );

            if (totalInvested === BigInt(0)) {
                throw new ServiceError(
                    "invalid_total_invested",
                    "Total invested amount cannot be zero.",
                    400,
                );
            }

            // Distribute returns pro-rata
            let totalDistributed = BigInt(0);
            const settledInvestments: Investment[] = [];

            for (let i = 0; i < investments.length; i += 1) {
                const investment = investments[i];
                const investmentBigInt = BigInt(this.normalizeAmount(investment.investmentAmount));

                // Calculate return: (paidAmount * investmentAmount) / totalInvested
                let actualReturn = (paidAmount * investmentBigInt) / totalInvested;

                // Handle rounding: last investor gets remainder to ensure exact distribution
                if (i === investments.length - 1) {
                    actualReturn = paidAmount - totalDistributed;
                }

                totalDistributed += actualReturn;

                investment.status = InvestmentStatus.SETTLED;
                investment.actualReturn = this.denormalizeAmount(actualReturn);

                const savedInvestment = await unitOfWork.saveInvestment(investment);
                settledInvestments.push(savedInvestment);
            }

            // Update invoice status
            invoice.status = InvoiceStatus.SETTLED;
            const savedInvoice = await unitOfWork.saveInvoice(invoice);

            // Create settlement transaction record for audit trail
            const settlementTransaction = unitOfWork.createTransaction({
                userId: invoice.sellerId,
                invoiceId: invoice.id,
                type: TransactionType.PAYMENT,
                amount: this.denormalizeAmount(paidAmount),
                status: TransactionStatus.COMPLETED,
                stellarTxHash: input.stellarTxHash ?? null,
                timestamp: input.settledAt ?? new Date(),
            });

            const savedTransaction = await unitOfWork.saveTransaction(settlementTransaction);

            return {
                invoiceId: savedInvoice.id,
                invoiceStatus: savedInvoice.status,
                investmentsSettled: settledInvestments.length,
                totalDistributed: this.denormalizeAmount(totalDistributed),
                transactionId: savedTransaction.id,
            };
        });
    }

    /**
     * Normalize decimal amount to BigInt (scale 4 decimal places)
     * Example: "1000.5000" → 10005000n
     */
    private normalizeAmount(amount: string): string {
        const normalized = amount.trim();

        if (!/^\d+(\.\d{1,4})?$/.test(normalized)) {
            throw new ServiceError(
                "invalid_amount_format",
                `Invalid amount format: ${amount}. Expected decimal with up to 4 decimal places.`,
                400,
            );
        }

        const [whole, fraction = ""] = normalized.split(".");
        const paddedFraction = `${fraction}${"0".repeat(4)}`.slice(0, 4);

        return `${whole}${paddedFraction}`;
    }

    /**
     * Denormalize BigInt back to decimal string (scale 4 decimal places)
     * Example: 10005000n → "1000.5000"
     */
    private denormalizeAmount(value: bigint): string {
        const str = value.toString().padStart(5, "0");
        const whole = str.slice(0, -4);
        const fraction = str.slice(-4);

        return `${whole}.${fraction}`;
    }
}

class TypeOrmSettlementTransactionRunner implements SettlementTransactionRunner {
    constructor(private readonly dataSource: DataSource) { }

    runInTransaction<T>(callback: (unitOfWork: SettlementUnitOfWork) => Promise<T>): Promise<T> {
        return this.dataSource.transaction(async (manager) =>
            callback({
                findInvoiceByIdForUpdate: (invoiceId: string) =>
                    manager.getRepository(Invoice).findOne({
                        where: { id: invoiceId },
                    }),
                findInvestmentsByInvoiceIdForUpdate: (invoiceId: string) =>
                    manager.getRepository(Investment).find({
                        where: { invoiceId },
                    }),
                saveInvoice: (invoice: Invoice) =>
                    manager.getRepository(Invoice).save(invoice),
                saveInvestment: (investment: Investment) =>
                    manager.getRepository(Investment).save(investment),
                saveTransaction: (transaction: Transaction) =>
                    manager.getRepository(Transaction).save(transaction),
                createTransaction: (input: Partial<Transaction>) =>
                    manager.getRepository(Transaction).create(input),
            }),
        );
    }
}

export function createSettlementService(dataSource: DataSource): SettlementService {
    return new SettlementService({
        transactionRunner: new TypeOrmSettlementTransactionRunner(dataSource),
    });
}
