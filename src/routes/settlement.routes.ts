import { Router } from "express";
import Joi from "joi";
import type { SettlementService } from "../services/settlement.service";
import { createSettlementController } from "../controllers/settlement.controller";
import { authenticateJWT } from "../middleware/auth.middleware";
import { validateBody } from "../middleware/validate.middleware";

const settleInvoiceSchema = Joi.object({
    invoiceId: Joi.string().uuid().required(),
    paidAmount: Joi.string()
        .required()
        .pattern(/^\d+(\.\d{1,4})?$/)
        .messages({ "string.pattern.base": "paidAmount must be a decimal number with max 4 decimal places" }),
    stellarTxHash: Joi.string().optional().trim().max(64),
    settledAt: Joi.date().iso().optional(),
});

export function createSettlementRouter(settlementService: SettlementService): Router {
    const router = Router();
    const controller = createSettlementController(settlementService);

    // POST /api/v1/settlement/settle - Settle an invoice and distribute pro-rata returns
    router.post(
        "/settle",
        authenticateJWT,
        validateBody(settleInvoiceSchema),
        controller.settleInvoice,
    );

    return router;
}
