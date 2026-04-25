import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import Joi from "joi";
import type { InvoiceService } from "../services/invoice.service";
import type { AppConfig } from "../config/env";
import { createInvoiceController } from "../controllers/invoice.controller";
import { authenticateJWT, requireKYC } from "../middleware/auth.middleware";
import { HttpError } from "../utils/http-error";

export interface InvoiceRouterDependencies {
  invoiceService: InvoiceService;
  config: AppConfig;
}

/**
 * Joi schemas for invoice validation
 */
const createInvoiceSchema = Joi.object({
  invoiceNumber: Joi.string().required().trim().max(64),
  customerName: Joi.string().required().trim().max(255),
  amount: Joi.string()
    .required()
    .pattern(/^\d+(\.\d{1,4})?$/)
    .messages({ "string.pattern.base": "amount must be a decimal number with max 4 decimal places" }),
  discountRate: Joi.string()
    .required()
    .pattern(/^\d+(\.\d{1,2})?$/)
    .custom((value, helpers) => {
      const num = parseFloat(value);
      if (num > 100) {
        return helpers.error("any.invalid");
      }
      return value;
    })
    .messages({ "any.invalid": "discountRate must be a percentage (0-100) with max 2 decimal places" }),
  dueDate: Joi.date().iso().required(),
  ipfsHash: Joi.string().optional().trim().max(128),
  riskScore: Joi.string()
    .optional()
    .pattern(/^\d+(\.\d{1,2})?$/)
    .custom((value, helpers) => {
      const num = parseFloat(value);
      if (num > 100) {
        return helpers.error("any.invalid");
      }
      return value;
    })
    .messages({ "any.invalid": "riskScore must be a percentage (0-100) with max 2 decimal places" }),
});

const updateInvoiceSchema = Joi.object({
  customerName: Joi.string().optional().trim().max(255),
  amount: Joi.string()
    .optional()
    .pattern(/^\d+(\.\d{1,4})?$/)
    .messages({ "string.pattern.base": "amount must be a decimal number with max 4 decimal places" }),
  discountRate: Joi.string()
    .optional()
    .pattern(/^\d+(\.\d{1,2})?$/)
    .max(100)
    .messages({ "string.pattern.base": "discountRate must be a percentage (0-100) with max 2 decimal places" }),
  dueDate: Joi.date().iso().optional(),
  riskScore: Joi.string()
    .optional()
    .pattern(/^\d+(\.\d{1,2})?$/)
    .max(100),
});

const getInvoicesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string().optional(),
});

/**
 * Validation middleware factory
 */
function validateBody(schema: Joi.Schema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const { error, value } = schema.validate(req.body, {
      stripUnknown: true,
      convert: true,
    });

    if (error) {
      return next(
        new HttpError(400, `Invalid request: ${error.message}`)
      );
    }

    req.body = value;
    next();
  };
}

function validateQuery(schema: Joi.Schema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const { error, value } = schema.validate(req.query, {
      stripUnknown: true,
      convert: true,
    });

    if (error) {
      return next(
        new HttpError(400, `Invalid query parameters: ${error.message}`)
      );
    }

    // Replace req.query with validated value
    // In Express, req.query is a getter/setter by default, but we can override it
    // if we use the default query parser.
    Object.keys(req.query).forEach(key => delete req.query[key]);
    Object.assign(req.query, value);
    next();
  };
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
      fileSize: config.ipfs.maxFileSizeMB * 1024 * 1024, // Convert MB to bytes
    },
    fileFilter: (req, file, cb) => {
      if (config.ipfs.allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`File type ${file.mimetype} is not allowed`));
      }
    },
  });

  // Rate limiting for document uploads
  const uploadRateLimit = rateLimit({
    windowMs: config.ipfs.uploadRateLimit.windowMs,
    max: config.ipfs.uploadRateLimit.maxUploads,
    message: {
      error: {
        code: "rate_limit_exceeded",
        message: `Too many upload attempts. Maximum ${config.ipfs.uploadRateLimit.maxUploads} uploads per ${config.ipfs.uploadRateLimit.windowMs / (60 * 1000)} minutes.`,
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const kycGating = requireKYC(config.kyc.skipVerification);

  // ============ INVOICE CRUD ENDPOINTS ============

  // GET /api/v1/invoices - List invoices for authenticated seller
  router.get(
    "/",
    authenticateJWT,
    validateQuery(getInvoicesQuerySchema),
    controller.getInvoices,
  );

  // POST /api/v1/invoices - Create new invoice
  router.post(
    "/",
    authenticateJWT,
    kycGating,
    validateBody(createInvoiceSchema),
    controller.createInvoice,
  );

  // GET /api/v1/invoices/:id - Get single invoice
  router.get("/:id", authenticateJWT, controller.getInvoice);

  // PUT /api/v1/invoices/:id - Update invoice
  router.put(
    "/:id",
    authenticateJWT,
    kycGating,
    validateBody(updateInvoiceSchema),
    controller.updateInvoice,
  );

  // DELETE /api/v1/invoices/:id - Delete invoice
  router.delete("/:id", authenticateJWT, kycGating, controller.deleteInvoice);

  // POST /api/v1/invoices/:id/publish - Publish invoice
  router.post(
    "/:id/publish",
    authenticateJWT,
    kycGating,
    controller.publishInvoice,
  );

  // POST /api/v1/invoices/:id/document - Upload document
  router.post(
    "/:id/document",
    uploadRateLimit,
    authenticateJWT,
    kycGating,
    upload.single("document"),
    controller.uploadDocument,
  );

  return router;
}
