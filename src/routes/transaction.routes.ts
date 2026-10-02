import { Router } from "express";
import { authenticateJWT } from "../middleware/auth.middleware";
import { createTransactionController } from "../controllers/transaction.controller";
import { TransactionService } from "../services/transaction.service";

export interface TransactionRouterDependencies {
  transactionService: TransactionService;
}

export function createTransactionRouter({ transactionService }: TransactionRouterDependencies): Router {
  const router = Router();
  const controller = createTransactionController(transactionService);

  // GET /api/v1/transactions
  router.get("/", authenticateJWT, controller.getHistory);

  return router;
}
