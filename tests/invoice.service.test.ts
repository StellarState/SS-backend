import { InvoiceService } from "../src/services/invoice.service";
import { ServiceError } from "../src/utils/service-error";
import { Invoice } from "../src/models/Invoice.model";
import { InvoiceStatus } from "../src/types/enums";

describe("InvoiceService", () => {
  let mockInvoiceRepository: any;
  let mockIPFSService: any;
  let invoiceService: InvoiceService;

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

  beforeEach(() => {
    mockInvoiceRepository = {
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    };

    mockIPFSService = {
      uploadFile: jest.fn(),
    };

    invoiceService = new InvoiceService({
      invoiceRepository: mockInvoiceRepository,
      ipfsService: mockIPFSService,
    });
  });

  // ============ CREATE INVOICE TESTS ============
  describe("createInvoice", () => {
    it("should successfully create an invoice", async () => {
      mockInvoiceRepository.findOneBy.mockResolvedValue(null);
      const createdInvoice = {
        ...mockInvoice,
        netAmount: "950.0000",
      };
      mockInvoiceRepository.create.mockReturnValue(createdInvoice);
      mockInvoiceRepository.save.mockResolvedValue(createdInvoice);

      const result = await invoiceService.createInvoice({
        sellerId: "seller-456",
        invoiceNumber: "INV-001",
        customerName: "Test Customer",
        amount: "1000.00",
        discountRate: "5.00",
        dueDate: new Date("2024-12-31"),
      });

      expect(result.id).toBe("invoice-123");
      expect(result.status).toBe(InvoiceStatus.DRAFT);
      expect(result.netAmount).toBe("950.0000");
      expect(mockInvoiceRepository.findOneBy).toHaveBeenCalledWith({
        invoiceNumber: "INV-001",
      });
    });

    it("should calculate net amount correctly", async () => {
      mockInvoiceRepository.findOneBy.mockResolvedValue(null);
      mockInvoiceRepository.create.mockReturnValue({
        ...mockInvoice,
        amount: "1000.00",
        discountRate: "10.00",
      });
      mockInvoiceRepository.save.mockResolvedValue({
        ...mockInvoice,
        amount: "1000.00",
        discountRate: "10.00",
        netAmount: "900.0000",
      });

      const result = await invoiceService.createInvoice({
        sellerId: "seller-456",
        invoiceNumber: "INV-001",
        customerName: "Test Customer",
        amount: "1000.00",
        discountRate: "10.00",
        dueDate: new Date("2024-12-31"),
      });

      expect(result.netAmount).toBe("900.0000");
    });

    it("should reject duplicate invoice number", async () => {
      mockInvoiceRepository.findOneBy.mockResolvedValue(mockInvoice);

      await expect(
        invoiceService.createInvoice({
          sellerId: "seller-456",
          invoiceNumber: "INV-001",
          customerName: "Test Customer",
          amount: "1000.00",
          discountRate: "5.00",
          dueDate: new Date("2024-12-31"),
        }),
      ).rejects.toThrow(ServiceError);

      await expect(
        invoiceService.createInvoice({
          sellerId: "seller-456",
          invoiceNumber: "INV-001",
          customerName: "Test Customer",
          amount: "1000.00",
          discountRate: "5.00",
          dueDate: new Date("2024-12-31"),
        }),
      ).rejects.toMatchObject({
        code: "invoice_number_exists",
        statusCode: 409,
      });
    });
  });

  // ============ GET INVOICE TESTS ============
  describe("getInvoiceById", () => {
    it("should retrieve invoice by id", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

      const result = await invoiceService.getInvoiceById("invoice-123");

      expect(result?.id).toBe("invoice-123");
      expect(mockInvoiceRepository.findOne).toHaveBeenCalledWith({
        where: { id: "invoice-123" },
      });
    });

    it("should return null when invoice not found", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(null);

      const result = await invoiceService.getInvoiceById("nonexistent");

      expect(result).toBeNull();
    });

    it("should verify ownership when sellerId provided", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

      const result = await invoiceService.getInvoiceById(
        "invoice-123",
        "seller-456",
      );

      expect(result?.id).toBe("invoice-123");
    });

    it("should throw error for unauthorized access", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

      await expect(
        invoiceService.getInvoiceById("invoice-123", "different-seller"),
      ).rejects.toMatchObject({
        code: "unauthorized_invoice_access",
        statusCode: 403,
      });
    });
  });

  // ============ GET INVOICES BY SELLER TESTS ============
  describe("getInvoicesBySellerId", () => {
    it("should list invoices for seller", async () => {
      mockInvoiceRepository.find.mockResolvedValue([mockInvoice]);
      mockInvoiceRepository.count.mockResolvedValue(1);

      const result = await invoiceService.getInvoicesBySellerId({
        sellerId: "seller-456",
      });

      expect(result.invoices).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it("should filter by status", async () => {
      mockInvoiceRepository.find.mockResolvedValue([mockInvoice]);
      mockInvoiceRepository.count.mockResolvedValue(1);

      await invoiceService.getInvoicesBySellerId({
        sellerId: "seller-456",
        status: InvoiceStatus.DRAFT,
      });

      expect(mockInvoiceRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: InvoiceStatus.DRAFT,
          }),
        }),
      );
    });

    it("should support pagination", async () => {
      mockInvoiceRepository.find.mockResolvedValue([mockInvoice]);
      mockInvoiceRepository.count.mockResolvedValue(50);

      await invoiceService.getInvoicesBySellerId({
        sellerId: "seller-456",
        skip: 10,
        take: 20,
      });

      expect(mockInvoiceRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 20,
        }),
      );
    });
  });

  // ============ UPDATE INVOICE TESTS ============
  describe("updateInvoice", () => {
    it("should update draft invoice", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      const updatedInvoice = { ...mockInvoice, customerName: "Updated Name" };
      mockInvoiceRepository.save.mockResolvedValue(updatedInvoice);

      const result = await invoiceService.updateInvoice({
        sellerId: "seller-456",
        invoiceId: "invoice-123",
        customerName: "Updated Name",
      });

      expect(result.customerName).toBe("Updated Name");
    });

    it("should recalculate net amount on amount/discount change", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      const updatedInvoice = {
        ...mockInvoice,
        amount: "2000.00",
        discountRate: "10.00",
        netAmount: "1800.0000",
      };
      mockInvoiceRepository.save.mockResolvedValue(updatedInvoice);

      const result = await invoiceService.updateInvoice({
        sellerId: "seller-456",
        invoiceId: "invoice-123",
        amount: "2000.00",
        discountRate: "10.00",
      });

      expect(result.netAmount).toBe("1800.0000");
    });

    it("should reject update of non-draft invoice", async () => {
      const publishedInvoice = { ...mockInvoice, status: InvoiceStatus.PUBLISHED };
      mockInvoiceRepository.findOne.mockResolvedValue(publishedInvoice);

      await expect(
        invoiceService.updateInvoice({
          sellerId: "seller-456",
          invoiceId: "invoice-123",
          customerName: "Updated",
        }),
      ).rejects.toMatchObject({
        code: "invalid_invoice_status",
        statusCode: 400,
      });
    });

    it("should throw error for unauthorized update", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

      await expect(
        invoiceService.updateInvoice({
          sellerId: "different-seller",
          invoiceId: "invoice-123",
          customerName: "Updated",
        }),
      ).rejects.toMatchObject({
        code: "unauthorized_invoice_access",
        statusCode: 403,
      });
    });

    it("should return 404 when invoice not found", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(null);

      await expect(
        invoiceService.updateInvoice({
          sellerId: "seller-456",
          invoiceId: "nonexistent",
          customerName: "Updated",
        }),
      ).rejects.toMatchObject({
        code: "invoice_not_found",
        statusCode: 404,
      });
    });
  });

  // ============ DELETE INVOICE TESTS ============
  describe("deleteInvoice", () => {
    it("should soft delete draft invoice", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      mockInvoiceRepository.save.mockResolvedValue({
        ...mockInvoice,
        deletedAt: new Date(),
      });

      await invoiceService.deleteInvoice("invoice-123", "seller-456");

      expect(mockInvoiceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          deletedAt: expect.any(Date),
        }),
      );
    });

    it("should reject deletion of published invoice", async () => {
      const publishedInvoice = { ...mockInvoice, status: InvoiceStatus.PUBLISHED };
      mockInvoiceRepository.findOne.mockResolvedValue(publishedInvoice);

      await expect(
        invoiceService.deleteInvoice("invoice-123", "seller-456"),
      ).rejects.toMatchObject({
        code: "invalid_invoice_status",
        statusCode: 400,
      });
    });

    it("should throw error for unauthorized delete", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

      await expect(
        invoiceService.deleteInvoice("invoice-123", "different-seller"),
      ).rejects.toMatchObject({
        code: "unauthorized_invoice_access",
        statusCode: 403,
      });
    });
  });

  // ============ PUBLISH INVOICE TESTS ============
  describe("publishInvoice", () => {
    it("should transition draft invoice to published", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      const publishedInvoice = { ...mockInvoice, status: InvoiceStatus.PUBLISHED };
      mockInvoiceRepository.save.mockResolvedValue(publishedInvoice);

      const result = await invoiceService.publishInvoice({
        invoiceId: "invoice-123",
        sellerId: "seller-456",
      });

      expect(result.status).toBe(InvoiceStatus.PUBLISHED);
    });

    it("should reject invalid status transitions", async () => {
      const settledInvoice = { ...mockInvoice, status: InvoiceStatus.SETTLED };
      mockInvoiceRepository.findOne.mockResolvedValue(settledInvoice);

      await expect(
        invoiceService.publishInvoice({
          invoiceId: "invoice-123",
          sellerId: "seller-456",
        }),
      ).rejects.toMatchObject({
        code: "invalid_status_transition",
        statusCode: 400,
      });
    });

    it("should throw error for unauthorized publish", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

      await expect(
        invoiceService.publishInvoice({
          invoiceId: "invoice-123",
          sellerId: "different-seller",
        }),
      ).rejects.toMatchObject({
        code: "unauthorized_invoice_access",
        statusCode: 403,
      });
    });

    it("should allow transition from pending to published", async () => {
      const pendingInvoice = { ...mockInvoice, status: InvoiceStatus.PENDING };
      mockInvoiceRepository.findOne.mockResolvedValue(pendingInvoice);
      const publishedInvoice = { ...pendingInvoice, status: InvoiceStatus.PUBLISHED };
      mockInvoiceRepository.save.mockResolvedValue(publishedInvoice);

      const result = await invoiceService.publishInvoice({
        invoiceId: "invoice-123",
        sellerId: "seller-456",
      });

      expect(result.status).toBe(InvoiceStatus.PUBLISHED);
    });
  });

  // ============ UPLOAD DOCUMENT TESTS ============
  describe("uploadDocument", () => {
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
