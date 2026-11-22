import { Request, Response } from "express";
import { SettlementService } from "../services/settlement.service";
import type { AuthenticatedRequest } from "../types/auth";

export class SettlementController {
  constructor(private readonly settlementService: SettlementService) {}

  settleInvoice = async (req: Request, res: Response) => {
    try {
      const invoiceId = req.params.invoiceId as string;
      const { proceeds } = req.body;

      if (!proceeds) {
        return res.status(400).json({
          error: {
            code: "MISSING_FIELDS",
            message: "proceeds is required",
          },
        });
      }

      const result = await this.settlementService.settleInvoice({
        invoiceId,
        proceeds,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: unknown) {
      const statusCode =
        (err as { statusCode?: number }).statusCode ||
        (err as { status?: number }).status ||
        400;
      return res.status(statusCode).json({
        error: {
          code: (err as { code?: string }).code || "INTERNAL_ERROR",
          message: (err as { message?: string }).message || "Internal server error",
        },
      });
    }
  };

  getHistory = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const wallet = req.params.wallet as string;
      if (req.user.stellarAddress !== wallet) return res.status(403).json({ error: { code: "FORBIDDEN", message: "Wallet does not belong to the authenticated user" } });
      const parseDate = (value: unknown) => value ? new Date(String(value)) : undefined;
      const fromDate = parseDate(req.query.from_date);
      const toDate = parseDate(req.query.to_date);
      if ((fromDate && Number.isNaN(fromDate.getTime())) || (toDate && Number.isNaN(toDate.getTime()))) return res.status(400).json({ error: { code: "INVALID_DATE", message: "from_date and to_date must be valid dates" } });
      const result = await this.settlementService.getSettlementHistory(wallet, {
        fromDate, toDate,
        invoiceType: typeof req.query.invoice_type === "string" ? req.query.invoice_type : undefined,
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
        limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
      });
      return res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      return res.status(500).json({ error: { code: "INTERNAL_ERROR", message: (err as Error).message } });
    }
  };

  exportHistory = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const wallet = req.params.wallet as string;
      if (req.user.stellarAddress !== wallet) return res.status(403).json({ error: { code: "FORBIDDEN", message: "Wallet does not belong to the authenticated user" } });
      const result = await this.settlementService.getSettlementHistory(wallet, { limit: 100 });
      const fields = ["invoice_id", "settled_at", "fractions_held", "principal_returned", "yield_earned", "fees", "net_return_usd", "net_return_pct"] as const;
      const csv = [fields.join(","), ...result.settlements.map((row) => fields.map((field) => JSON.stringify(row[field])).join(","))].join("\n");
      return res.type("text/csv").attachment("settlement-history.csv").send(csv);
    } catch (err: unknown) {
      return res.status(500).json({ error: { code: "INTERNAL_ERROR", message: (err as Error).message } });
    }
  };
}
