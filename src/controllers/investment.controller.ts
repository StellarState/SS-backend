import { Request, Response } from "express";
import { InvestmentService } from "../services/investment.service";
import { AuthenticatedRequest } from "../types/auth";
import { requireApprovedKYC } from "../lib/kyc";

export class InvestmentController {
  constructor(private readonly investmentService: InvestmentService) {}

  createInvestment = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Enforce KYC check
      requireApprovedKYC(user);

      const { invoiceId, investmentAmount } = req.body;

      if (!invoiceId || !investmentAmount) {
        return res.status(400).json({
          error: {
            code: "MISSING_FIELDS",
            message: "invoiceId and investmentAmount are required",
          },
        });
      }

      const investment = await this.investmentService.createInvestment({
        invoiceId,
        investorId: user.id,
        investmentAmount,
      });

      return res.status(201).json({
        success: true,
        data: investment,
      });
    } catch (err: any) {
      const statusCode = err.status || err.statusCode || 400;
      return res.status(statusCode).json({
        error: {
          code: err.code || "INTERNAL_ERROR",
          message: err.message || "Internal server error",
        },
      });
    }
  };
}
