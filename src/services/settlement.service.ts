import { DataSource, EntityManager } from "typeorm";
import { Decimal } from "decimal.js";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { Transaction } from "../models/Transaction.model";
import { InvoiceStatus, InvestmentStatus, TransactionType, TransactionStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";

/**
 * Settlement Flow: Funded → Settled
 *
 * This service implements the MVP settlement path that transitions:
 * - Invoice: FUNDED → SETTLED
 * - Investments: CONFIRMED → SETTLED with actual_return populated
 * - Pro-rata distribution of settlement proceeds across investors
 *
 * IMPORTANT: This is an MVP bridge until on-chain settlement drives status via Soroban events.
 * Future versions will be replaced/augmented by automated Soroban oracle settlement.
 *
 * Authorization: Only authenticated admin or seller with strict checks can call settlement.
 * For MVP, we enforce seller ownership of the invoice.
 */

export interface SettleInvoiceInput {
    invoiceId: string;
    sellerId: string;
    paidAmount: string;
    stellarTxHash?: string;
    settledAt?: Date;
}

export interface SettlementResult {
    invoiceId: string;
    invoiceStatus: InvoiceStatus;
    investmentsSettled: number;
    totalDistributed: string;
    transactionId?: string;
}

export class SettlementService {
    constructor(private readonly dataSource: DataSource) { }

    /**
     * Settle an invoice and distribute pro-rata returns to investors.
     *
     * Pro-rata formula:
     * For each investor: actual_return = (investmentAmount / totalInvested) * paidAmount
     *
     * Rounding strategy: Fixed precision to 4 decimal places; last investor absorbs rounding difference.
     *
     * Idempotency: Calling settlement twice returns the same result without double-paying.
     * We check if invoice is already SETTLED and return early.
     */
    async settleInvoice(input: SettleInvoiceInput): Promise<SettlementResult> {
        const { invoiceId, sellerId, paidAmount, stellarTxHash, settledAt } = input;

        // Validate paid amount
        const paidAmountDecimal = new Decimal(paidAmount);
        if (paidAmountDecimal.isNegative() || paidAmountDecimal.isZero()) {
            throw new ServiceError(
                "INVALID_SETTLEMENT_AMOUNT",
                "Paid amount must be greater than zero",
                400,
            );
        }

        return await this.dataSource.transaction(async (manager: EntityManager) => {
            // 1. Lock and fetch invoice
            const invoice = await manager
                .createQueryBuilder(Invoice, "invoice")
                .setLock("pessimistic_write")
                .where("invoice.id = :id", { id: invoiceId })
                .getOne();

            if (!invoice) {
                throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
            }

            // 2. Verify seller ownership
            if (invoice.sellerId !== sellerId) {
                throw new ServiceError(
                    "UNAUTHORIZED_SETTLEMENT",
                    "Only the invoice seller can settle",
                    403,
                );
            }

            // 3. Check invoice status - idempotency: if already settled, return success
            if (invoice.status === InvoiceStatus.SETTLED) {
                const settledInvestments = await manager.find(Investment, {
                    where: { invoiceId, status: InvestmentStatus.SETTLED },
                });

                return {
                    invoiceId,
                    invoiceStatus: InvoiceStatus.SETTLED,
                    investmentsSettled: settledInvestments.length,
                    totalDistributed: paidAmount,
                };
            }

            // 4. Validate state transition
            if (invoice.status !== InvoiceStatus.FUNDED) {
                throw new ServiceError(
                    "INVALID_INVOICE_STATE",
                    `Cannot settle invoice in ${invoice.status} status. Only FUNDED invoices can be settled.`,
                    400,
                );
            }

            // 5. Fetch all CONFIRMED investments for this invoice
            const investments = await manager.find(Investment, {
                where: { invoiceId, status: InvestmentStatus.CONFIRMED },
                order: { createdAt: "ASC" }, // Stable ordering for deterministic rounding
            });

            if (investments.length === 0) {
                throw new ServiceError(
                    "NO_CONFIRMED_INVESTMENTS",
                    "Cannot settle invoice with no confirmed investments",
                    400,
                );
            }

            // 6. Calculate total invested amount
            const totalInvested = investments.reduce(
                (sum, inv) => sum.plus(new Decimal(inv.investmentAmount)),
                new Decimal(0),
            );

            if (totalInvested.isZero()) {
                throw new ServiceError(
                    "ZERO_TOTAL_INVESTED",
                    "Total invested amount is zero",
                    400,
                );
            }

            // 7. Distribute pro-rata returns
            let totalDistributed = new Decimal(0);
            const settledInvestments: Investment[] = [];

            for (let i = 0; i < investments.length; i++) {
                const investment = investments[i];
                const investmentAmount = new Decimal(investment.investmentAmount);

                let actualReturn: Decimal;

                if (i === investments.length - 1) {
                    // Last investor: absorb rounding difference
                    actualReturn = paidAmountDecimal.minus(totalDistributed);
                } else {
                    // Pro-rata: (investmentAmount / totalInvested) * paidAmount
                    actualReturn = investmentAmount
                        .dividedBy(totalInvested)
                        .times(paidAmountDecimal)
                        .toDecimalPlaces(4, Decimal.ROUND_DOWN);
                }

                investment.actualReturn = actualReturn.toFixed(4);
                investment.status = InvestmentStatus.SETTLED;

                const savedInvestment = await manager.save(Investment, investment);
                settledInvestments.push(savedInvestment);

                totalDistributed = totalDistributed.plus(actualReturn);
            }

            // 8. Create PAYMENT transaction for audit trail
            const paymentTransaction = manager.create(Transaction, {
                userId: sellerId,
                invoiceId,
                type: TransactionType.PAYMENT,
                amount: paidAmount,
                status: TransactionStatus.COMPLETED,
                stellarTxHash: stellarTxHash || null,
                timestamp: settledAt || new Date(),
            });

            await manager.save(Transaction, paymentTransaction);

            // 9. Transition invoice to SETTLED
            invoice.status = InvoiceStatus.SETTLED;
            await manager.save(Invoice, invoice);

            return {
                invoiceId,
                invoiceStatus: InvoiceStatus.SETTLED,
                investmentsSettled: settledInvestments.length,
                totalDistributed: totalDistributed.toFixed(4),
                transactionId: paymentTransaction.id,
            };
        });
    }
}

export function createSettlementService(dataSource: DataSource): SettlementService {
    return new SettlementService(dataSource);
}
