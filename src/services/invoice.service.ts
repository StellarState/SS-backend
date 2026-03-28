import { DataSource } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { ServiceError } from "../utils/service-error";
import type { IPFSService, IPFSUploadResult } from "./ipfs.service";

export interface InvoiceRepositoryContract {
  findOne(options: { where: { id: string } }): Promise<Invoice | null>;
  save(invoice: Invoice): Promise<Invoice>;
}

export interface InvoiceServiceDependencies {
  invoiceRepository: InvoiceRepositoryContract;
  ipfsService: IPFSService;
}

export interface UploadDocumentInput {
  invoiceId: string;
  sellerId: string;
  fileBuffer: Buffer;
  filename: string;
  mimeType: string;
}

export interface UploadDocumentResult {
  invoiceId: string;
  ipfsHash: string;
  fileSize: number;
  uploadedAt: string;
}

export class InvoiceService {
  private readonly invoiceRepository: InvoiceRepositoryContract;
  private readonly ipfsService: IPFSService;

  constructor(dependencies: InvoiceServiceDependencies) {
    this.invoiceRepository = dependencies.invoiceRepository;
    this.ipfsService = dependencies.ipfsService;
  }

  async uploadDocument(input: UploadDocumentInput): Promise<UploadDocumentResult> {
    // Find the invoice
    const invoice = await this.invoiceRepository.findOne({
      where: { id: input.invoiceId },
    });
    if (!invoice) {
      throw new ServiceError("invoice_not_found", "Invoice not found", 404);
    }

    // Verify ownership
    if (invoice.sellerId !== input.sellerId) {
      throw new ServiceError(
        "unauthorized_invoice_access",
        "You can only upload documents to your own invoices",
        403,
      );
    }

    // Upload to IPFS
    const uploadResult: IPFSUploadResult = await this.ipfsService.uploadFile(
      input.fileBuffer,
      input.filename,
      input.mimeType,
    );

    // Update invoice with IPFS hash
    invoice.ipfsHash = uploadResult.hash;
    await this.invoiceRepository.save(invoice);

    return {
      invoiceId: input.invoiceId,
      ipfsHash: uploadResult.hash,
      fileSize: uploadResult.size,
      uploadedAt: uploadResult.timestamp,
    };
  }
}

export function createInvoiceService(
  dataSource: DataSource,
  ipfsService: IPFSService,
): InvoiceService {
  const invoiceRepository = dataSource.getRepository(Invoice);
  
  return new InvoiceService({
    invoiceRepository,
    ipfsService,
  });
}