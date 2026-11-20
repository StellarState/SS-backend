import { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import type { TaxStatementService } from "../services/tax-statement.service";

export class TaxStatementController {
  constructor(private readonly taxStatementService: TaxStatementService) {}

  /**
   * GET /api/investors/me/statements/:year
   * Returns JSON totals and per-invoice breakdown (#873).
   */
  getStatement = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const rawYear = String(req.params.year);
      const cleanYear = rawYear.replace(/\.(json|pdf|csv)$/i, "");
      const statement = await this.taxStatementService.build(user.id, cleanYear);

      return res.status(200).json({
        success: true,
        data: statement,
        ...statement,
      });
    } catch (err: unknown) {
      return sendError(res, err);
    }
  };

  /**
   * GET /api/investors/me/statements/:year.pdf
   * Returns PDF generated with pdfkit from object storage cache or rendered fresh (#873).
   */
  getStatementPdf = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const rawYear = String(req.params.year);
      const cleanYear = rawYear.replace(/\.pdf$/i, "");
      const pdfBuffer = await this.taxStatementService.getOrGeneratePdf(user.id, cleanYear);

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="tax-statement-${cleanYear}.pdf"`,
      );
      return res.status(200).send(pdfBuffer);
    } catch (err: unknown) {
      return sendError(res, err);
    }
  };

  /**
   * GET /api/investors/me/statements/:year.csv
   * Streams the same statement rows and totals in CSV format (#873).
   */
  getStatementCsv = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const rawYear = String(req.params.year);
      const cleanYear = rawYear.replace(/\.csv$/i, "");
      const statement = await this.taxStatementService.build(user.id, cleanYear);

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="tax-statement-${cleanYear}.csv"`,
      );
      const stream = this.taxStatementService.streamCsv(statement);
      return stream.pipe(res);
    } catch (err: unknown) {
      return sendError(res, err);
    }
  };
}

function sendError(res: Response, err: unknown): Response {
  const statusCode =
    (err as { statusCode?: number }).statusCode ||
    (err as { status?: number }).status ||
    500;
  return res.status(statusCode).json({
    error: {
      code: (err as { code?: string }).code || "INTERNAL_ERROR",
      message: (err as { message?: string }).message || "Internal server error",
    },
  });
}
