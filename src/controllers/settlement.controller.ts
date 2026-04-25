import type { Response, NextFunction } from "express";
import type { SettlementService } from "../services/settlement.service";
import { AuthenticatedRequest } from "../types/auth";
import { HttpError } from "../utils/http-error";
import { ServiceError } from "../utils/service-error";

export interface SettleInvoiceRequest extends AuthenticatedRequest {
    body: {
        invoiceId: string;
        paidAmount: string;
        stellarTxHash?: string;
        settledAt?: string;
    };
}

export function createSettlementController(settlementService: SettlementService) {
    return {
        async settleInvoice(
            req: SettleInvoiceRequest,
            res: Response,
            next: NextFunction,
        ): Promise<void> {
            try {
                if (!req.user) {
                    throw new HttpError(401, "Authentication required");
                }

                const { invoiceId, paidAmount, stellarTxHash, settledAt } = req.body;

                if (!invoiceId || !paidAmount) {
                    throw new HttpError(400, "invoiceId and paidAmount are required");
                }

                const result = await settlementService.settleInvoice({
                    invoiceId,
                    sellerId: req.user.id,
                    paidAmount,
                    stellarTxHash,
                    settledAt: settledAt ? new Date(settledAt) : undefined,
                });

                res.status(200).json({
                    success: true,
                    data: result,
                });
            } catch (error) {
                if (error instanceof ServiceError) {
                    next(new HttpError(error.statusCode, error.message));
                    return;
                }

                if (error instanceof HttpError) {
                    next(error);
                    return;
                }

                next(error);
            }
        },
    };
}
