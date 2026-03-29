import type { Request, Response, NextFunction } from "express";
import Joi from "joi";
import type { SettlementService } from "../services/settlement.service";
import { HttpError } from "../utils/http-error";
import { ServiceError } from "../utils/service-error";
import { UserType } from "../types/enums";

const settleInvoiceSchema = Joi.object({
    paidAmount: Joi.string().regex(/^\d+(\.\d{1,4})?$/).required(),
    stellarTxHash: Joi.string().length(64).optional(),
    settledAt: Joi.date().iso().optional(),
});

export interface SettleInvoiceRequest extends Request {
    params: {
        id: string;
    };
    body: {
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

                // MVP: Only sellers can settle their own invoices
                if (req.user.userType !== UserType.SELLER && req.user.userType !== UserType.BOTH) {
                    throw new HttpError(403, "Only sellers can settle invoices");
                }

                const { error, value } = settleInvoiceSchema.validate(req.body, {
                    abortEarly: false,
                    stripUnknown: true,
                });

                if (error) {
                    throw new HttpError(
                        400,
                        "Request validation failed.",
                        error.details.map((detail) => detail.message),
                    );
                }

                const { id: invoiceId } = req.params;

                const result = await settlementService.settleInvoice({
                    invoiceId,
                    paidAmount: value.paidAmount,
                    stellarTxHash: value.stellarTxHash,
                    settledAt: value.settledAt ? new Date(value.settledAt) : undefined,
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

                next(error);
            }
        },
    };
}
