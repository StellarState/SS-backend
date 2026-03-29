import { InvoiceService } from "../src/services/invoice.service";
import { ServiceError } from "../src/utils/service-error";
import { Invoice } from "../src/models/Invoice.model";
import { InvoiceStatus } from "../src/types/enums";

describe("InvoiceService", () => {
  let mockInvoiceRepository: any;
  let mockIPFSService: any;
  let invoiceService: InvoiceService;

  beforeEach(() => {
    mockInvoiceRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
    };

    mockIPFSService = {
      uploadFile: jest.fn(),
    };

    invoiceService = new InvoiceService({
      invoiceRepository: mockInvoiceRepository,
      ipfsService: mockIPFSService,
    });
  });

  describe("uploadDocument", () => {
    const mockInvoice = {
      id: "invoice-123",
      sellerId: "seller-456",
      invoiceNumber: "INV-001",
      customerName: "Test Customer",
      amount: "1000.00",
      discountRate: "5.00",
      netAmount: "950.00",
      dueDate: new Date("2024-12-31"),
      ipfsHash: null,
      riskScore: null,
      status: InvoiceStatus.DRAFT,
      smartContractId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as Invoice;

    const uploadInput = {
      invoiceId: "invoice-123",
      sellerId: "seller-456",
      fileBuffer: Buffer.from("test file"),
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    };

    it("should successfully upload document for valid invoice", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      mockIPFSService.uploadFile.mockResolvedValue({
        hash: "QmTestHash123",
        size: 1024,
        timestamp: "2024-01-01T00:00:00.000Z",
      });

      const updatedInvoice = { ...mockInvoice, ipfsHash: "QmTestHash123" };
      mockInvoiceRepository.save.mockResolvedValue(updatedInvoice);

      const result = await invoiceService.uploadDocument(uploadInput);

      expect(result).toEqual({
        invoiceId: "invoice-123",
        ipfsHash: "QmTestHash123",
        fileSize: 1024,
        uploadedAt: "2024-01-01T00:00:00.000Z",
      });

      expect(mockInvoiceRepository.findOne).toHaveBeenCalledWith({
        where: { id: "invoice-123" },
      });
      expect(mockIPFSService.uploadFile).toHaveBeenCalledWith(
        uploadInput.fileBuffer,
        uploadInput.filename,
        uploadInput.mimeType,
      );
      expect(mockInvoiceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          ipfsHash: "QmTestHash123",
        }),
      );
    });

    it("should throw error when invoice not found", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(null);

      await expect(invoiceService.uploadDocument(uploadInput)).rejects.toThrow(
        ServiceError,
      );

      await expect(invoiceService.uploadDocument(uploadInput)).rejects.toMatchObject({
        code: "invoice_not_found",
        statusCode: 404,
      });
    });

    it("should throw error when user is not the seller", async () => {
      const wrongSellerInvoice = { ...mockInvoice, sellerId: "different-seller" };
      mockInvoiceRepository.findOne.mockResolvedValue(wrongSellerInvoice);

      await expect(invoiceService.uploadDocument(uploadInput)).rejects.toThrow(
        ServiceError,
      );

      await expect(invoiceService.uploadDocument(uploadInput)).rejects.toMatchObject({
        code: "unauthorized_invoice_access",
        statusCode: 403,
      });
    });

    it("should propagate IPFS service errors", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      mockIPFSService.uploadFile.mockRejectedValue(
        new ServiceError("file_too_large", "File too large", 400),
      );

      await expect(invoiceService.uploadDocument(uploadInput)).rejects.toThrow(
        ServiceError,
      );

      await expect(invoiceService.uploadDocument(uploadInput)).rejects.toMatchObject({
        code: "file_too_large",
        statusCode: 400,
      });
    });
  });
});