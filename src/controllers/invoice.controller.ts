import type { Request, Response, NextFunction } from "express";
import type { InvoiceService } from "../services/invoice.service";
import { HttpError } from "../utils/http-error";
import { ServiceError } from "../utils/service-error";

export interface UploadDocumentRequest extends Request {
  params: {
    id: string;
  };
  file?: Express.Multer.File;
}

export function createInvoiceController(invoiceService: InvoiceService) {
  return {
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