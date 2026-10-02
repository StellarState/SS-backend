import { Request, Response, NextFunction } from "express";
import { TransactionService } from "../services/transaction.service";
import { AuthenticatedRequest } from "../types/auth";
import { HttpError } from "../utils/http-error";
import { ServiceError } from "../utils/service-error";

export function createTransactionController(transactionService: TransactionService) {
  return {
    async getHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const authReq = req as AuthenticatedRequest;
        const userId = authReq.user?.id;

        if (!userId) {
          throw new HttpError(401, "Unauthorized");
        }

        const { type, cursor, limit } = req.query;

        let types: string[] | undefined;
        if (type) {
          types = typeof type === "string" ? type.split(",") : Array.isArray(type) ? (type as string[]) : undefined;
        }

        const result = await transactionService.getWalletHistory({
          userId,
          types,
          cursor: cursor as string,
          limit: limit ? parseInt(limit as string, 10) : 20,
        });

        res.status(200).json({
          success: true,
          data: result.data,
          meta: {
            total: result.total,
            nextCursor: result.nextCursor,
          },
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
