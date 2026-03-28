import { Router } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import type { InvoiceService } from "../services/invoice.service";
import type { AppConfig } from "../config/env";
import { createInvoiceController } from "../controllers/invoice.controller";
import { authenticateJWT } from "../middleware/auth.middleware";

export interface InvoiceRouterDependencies {
  invoiceService: InvoiceService;
  config: AppConfig["ipfs"];
}

export function createInvoiceRouter({
  invoiceService,
  config,
}: InvoiceRouterDependencies): Router {
  const router = Router();
  const controller = createInvoiceController(invoiceService);

  // Configure multer for file uploads
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.maxFileSizeMB * 1024 * 1024, // Convert MB to bytes
    },
    fileFilter: (req, file, cb) => {
      if (config.allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`File type ${file.mimetype} is not allowed`));
      }
    },
  });

  // Rate limiting for document uploads
  const uploadRateLimit = rateLimit({
    windowMs: config.uploadRateLimit.windowMs,
    max: config.uploadRateLimit.maxUploads,
    message: {
      error: {
        code: "rate_limit_exceeded",
        message: `Too many upload attempts. Maximum ${config.uploadRateLimit.maxUploads} uploads per ${config.uploadRateLimit.windowMs / (60 * 1000)} minutes.`,
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // POST /api/v1/invoices/:id/document
  router.post(
    "/:id/document",
    uploadRateLimit,
    authenticateJWT,
    upload.single("document"),
    controller.uploadDocument,
  );

  return router;
}