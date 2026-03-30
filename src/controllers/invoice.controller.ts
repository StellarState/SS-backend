import type { Request, Response, NextFunction } from "express";
import type { InvoiceService } from "../services/invoice.service";
import { HttpError } from "../utils/http-error";
import { ServiceError } from "../utils/service-error";
import { AuthenticatedRequest } from "../types/auth";

export interface UploadDocumentRequest extends Request {
  params: {
    id: string;
  };
  file?: Express.Multer.File;
}

export interface CreateInvoiceRequest extends AuthenticatedRequest {
  body: {
    invoiceNumber: string;
    customerName: string;
    amount: string;
    discountRate: string;
    dueDate: string;
    ipfsHash?: string;
    riskScore?: string;
  };
}

export interface UpdateInvoiceRequest extends AuthenticatedRequest {
  params: {
    id: string;
  };
  body: {
    customerName?: string;
    amount?: string;
    discountRate?: string;
    dueDate?: string;
    riskScore?: string;
  };
}

export interface GetInvoicesRequest extends AuthenticatedRequest {
  query: any;
}

export interface PublishInvoiceRequest extends AuthenticatedRequest {
  params: {
    id: string;
  };
}

export function createInvoiceController(invoiceService: InvoiceService) {
  return {
    async createInvoice(
      req: CreateInvoiceRequest,
      res: Response,
      next: NextFunction,
    ): Promise<void> {
      try {
        if (!req.user) {
          throw new HttpError(401, "Authentication required");
        }

        const {
          invoiceNumber,
          customerName,
          amount,
          discountRate,
          dueDate,
          ipfsHash,
          riskScore,
        } = req.body;

        const result = await invoiceService.createInvoice({
          sellerId: req.user.id,
          invoiceNumber,
          customerName,
          amount,
          discountRate,
          dueDate: new Date(dueDate),
          ipfsHash,
          riskScore,
        });

        res.status(201).json({
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

    async getInvoices(
      req: GetInvoicesRequest,
      res: Response,
      next: NextFunction,
    ): Promise<void> {
      try {
        if (!req.user) {
          throw new HttpError(401, "Authentication required");
        }

        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 20;
        const status = req.query.status;

        // Validate pagination
        if (page < 1 || limit < 1 || limit > 100) {
          throw new HttpError(400, "Invalid pagination parameters");
        }

        const result = await invoiceService.getInvoicesBySellerId({
          sellerId: req.user.id,
          status: status as any,
          skip: (page - 1) * limit,
          take: limit,
        });

        res.status(200).json({
          success: true,
          data: result.invoices,
          meta: {
            total: result.total,
            page,
            limit,
            totalPages: Math.ceil(result.total / limit),
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

    async getInvoice(
      req: Request & { params: { id: string } },
      res: Response,
      next: NextFunction,
    ): Promise<void> {
      try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.user) {
          throw new HttpError(401, "Authentication required");
        }

        const { id } = req.params;

        try {
          const result = await invoiceService.getInvoiceById(
            id,
            authReq.user.id,
          );

          if (!result) {
            throw new HttpError(404, "Invoice not found");
          }

          res.status(200).json({
            success: true,
            data: result,
          });
        } catch (error) {
          if (error instanceof ServiceError && error.statusCode === 403) {
            // Return 404 instead of 403 to prevent info leakage
            throw new HttpError(404, "Invoice not found");
          }
          throw error;
        }
      } catch (error) {
        if (error instanceof ServiceError) {
          next(new HttpError(error.statusCode, error.message));
          return;
        }

        next(error);
      }
    },

    async updateInvoice(
      req: UpdateInvoiceRequest,
      res: Response,
      next: NextFunction,
    ): Promise<void> {
      try {
        if (!req.user) {
          throw new HttpError(401, "Authentication required");
        }

        const { id } = req.params;
        const { customerName, amount, discountRate, dueDate, riskScore } =
          req.body;

        const result = await invoiceService.updateInvoice({
          sellerId: req.user.id,
          invoiceId: id,
          customerName,
          amount,
          discountRate,
          dueDate: dueDate ? new Date(dueDate) : undefined,
          riskScore,
        });

        res.status(200).json({
          success: true,
          data: result,
        });
      } catch (error) {
        if (error instanceof ServiceError) {
          if (error.statusCode === 403) {
            // Return 404 instead of 403 to prevent info leakage
            next(new HttpError(404, "Invoice not found"));
            return;
          }
          next(new HttpError(error.statusCode, error.message));
          return;
        }

        next(error);
      }
    },

    async deleteInvoice(
      req: Request & { params: { id: string } },
      res: Response,
      next: NextFunction,
    ): Promise<void> {
      try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.user) {
          throw new HttpError(401, "Authentication required");
        }

        const { id } = req.params;

        await invoiceService.deleteInvoice(id, authReq.user.id);

        res.status(204).send();
      } catch (error) {
        if (error instanceof ServiceError) {
          if (error.statusCode === 403) {
            // Return 404 instead of 403 to prevent info leakage
            next(new HttpError(404, "Invoice not found"));
            return;
          }
          next(new HttpError(error.statusCode, error.message));
          return;
        }

        next(error);
      }
    },

    async publishInvoice(
      req: PublishInvoiceRequest,
      res: Response,
      next: NextFunction,
    ): Promise<void> {
      try {
        if (!req.user) {
          throw new HttpError(401, "Authentication required");
        }

        const { id } = req.params;

        const result = await invoiceService.publishInvoice({
          invoiceId: id,
          sellerId: req.user.id,
        });

        res.status(200).json({
          success: true,
          data: result,
        });
      } catch (error) {
        if (error instanceof ServiceError) {
          if (error.statusCode === 403) {
            // Return 404 instead of 403 to prevent info leakage
            next(new HttpError(404, "Invoice not found"));
            return;
          }
          next(new HttpError(error.statusCode, error.message));
          return;
        }

        next(error);
      }
    },

    async uploadDocument(
      req: UploadDocumentRequest,
      res: Response,
      next: NextFunction,
    ): Promise<void> {
      try {
        if (!req.user) {
          throw new HttpError(401, "Authentication required");
        }

        if (!req.file) {
          throw new HttpError(400, "No file uploaded");
        }

        const { id: invoiceId } = req.params;
        const sellerId = req.user.id;

        const result = await invoiceService.uploadDocument({
          invoiceId,
          sellerId,
          fileBuffer: req.file.buffer,
          filename: req.file.originalname,
          mimeType: req.file.mimetype,
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
