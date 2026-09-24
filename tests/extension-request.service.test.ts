import { DataSource, EntityManager, SelectQueryBuilder } from "typeorm";
import { ExtensionRequestService } from "../src/services/extension-request.service";
import { Invoice } from "../src/models/Invoice.model";
import { ExtensionRequest, ExtensionRequestStatus } from "../src/models/ExtensionRequest.model";
import { InvoiceStatus } from "../src/types/enums";
import { ServiceError } from "../src/utils/service-error";

describe("ExtensionRequestService", () => {
  let mockDataSource: jest.Mocked<DataSource>;
  let mockEntityManager: jest.Mocked<EntityManager>;
  let mockQueryBuilder: jest.Mocked<SelectQueryBuilder<Invoice>>;
  let mockExtensionRepo: any;
  let mockInvoiceRepo: any;
  let mockInvestmentRepo: any;
  let mockNotificationService: any;
  let service: ExtensionRequestService;

  const getMockInvoice = (status: InvoiceStatus) =>
    ({
      id: "invoice-1",
      dueDate: new Date("2026-02-01"),
      status,
    } as Invoice);

  beforeEach(() => {
    mockQueryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    } as any;

    mockExtensionRepo = {
      findOne: jest.fn(),
      create: jest.fn((data: any) => data),
      save: jest.fn((data: any) => Promise.resolve(data)),
    };

    mockInvoiceRepo = {
      update: jest.fn().mockResolvedValue(undefined),
    };

    mockInvestmentRepo = {
      find: jest.fn().mockResolvedValue([]),
    };

    mockEntityManager = {
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
      getRepository: jest.fn((entity: any) => {
        if (entity === ExtensionRequest) return mockExtensionRepo;
        if (entity === Invoice) return mockInvoiceRepo;
        return mockInvestmentRepo;
      }),
    } as any;

    mockDataSource = {
      transaction: jest.fn().mockImplementation((cb) => cb(mockEntityManager)),
    } as any;

    mockNotificationService = { createNotification: jest.fn() };

    service = new ExtensionRequestService(mockDataSource, mockNotificationService);
  });

  describe("requestExtension", () => {
    it("stores the proposed deadline and sets status to pending", async () => {
      mockQueryBuilder.getOne.mockResolvedValue(getMockInvoice(InvoiceStatus.PUBLISHED));
      mockExtensionRepo.findOne.mockResolvedValue(null);

      const result = await service.requestExtension({
        invoiceId: "invoice-1",
        requestedBy: "seller-1",
        proposedDeadline: new Date("2026-03-01"),
      });

      expect(result.status).toBe(ExtensionRequestStatus.PENDING);
      expect(result.currentDeadline).toEqual(new Date("2026-02-01"));
    });

    it("rejects a second request while one is already pending", async () => {
      mockQueryBuilder.getOne.mockResolvedValue(getMockInvoice(InvoiceStatus.PUBLISHED));
      mockExtensionRepo.findOne.mockResolvedValue({ id: "existing-req" });

      await expect(
        service.requestExtension({
          invoiceId: "invoice-1",
          requestedBy: "seller-1",
          proposedDeadline: new Date("2026-03-01"),
        }),
      ).rejects.toThrow(ServiceError);
    });

    it.each([InvoiceStatus.FUNDED, InvoiceStatus.SETTLED])(
      "rejects extension on a %s invoice with 422",
      async (status) => {
        mockQueryBuilder.getOne.mockResolvedValue(getMockInvoice(status));

        await expect(
          service.requestExtension({
            invoiceId: "invoice-1",
            requestedBy: "seller-1",
            proposedDeadline: new Date("2026-03-01"),
          }),
        ).rejects.toMatchObject({ statusCode: 422 });
      },
    );
  });

  describe("reviewExtension", () => {
    const pendingRequest = () =>
      ({
        id: "req-1",
        invoiceId: "invoice-1",
        status: ExtensionRequestStatus.PENDING,
        proposedDeadline: new Date("2026-03-01"),
      } as ExtensionRequest);

    it("approving updates the invoice deadline atomically and notifies investors", async () => {
      mockExtensionRepo.findOne.mockResolvedValue(pendingRequest());
      mockInvestmentRepo.find.mockResolvedValue([
        { investorId: "investor-1" },
        { investorId: "investor-2" },
      ]);

      const result = await service.reviewExtension({
        invoiceId: "invoice-1",
        requestId: "req-1",
        reviewerId: "admin-1",
        approve: true,
      });

      expect(result.status).toBe(ExtensionRequestStatus.APPROVED);
      expect(mockInvoiceRepo.update).toHaveBeenCalledWith("invoice-1", {
        dueDate: new Date("2026-03-01"),
      });
      expect(mockNotificationService.createNotification).toHaveBeenCalledTimes(2);
    });

    it("rejecting does not touch the invoice deadline", async () => {
      mockExtensionRepo.findOne.mockResolvedValue(pendingRequest());

      const result = await service.reviewExtension({
        invoiceId: "invoice-1",
        requestId: "req-1",
        reviewerId: "admin-1",
        approve: false,
        rejectionReason: "Insufficient justification",
      });

      expect(result.status).toBe(ExtensionRequestStatus.REJECTED);
      expect(mockInvoiceRepo.update).not.toHaveBeenCalled();
    });

    it("rejects reviewing an already-decided request", async () => {
      mockExtensionRepo.findOne.mockResolvedValue({
        ...pendingRequest(),
        status: ExtensionRequestStatus.APPROVED,
      });

      await expect(
        service.reviewExtension({
          invoiceId: "invoice-1",
          requestId: "req-1",
          reviewerId: "admin-1",
          approve: true,
        }),
      ).rejects.toThrow(ServiceError);
    });
  });
});
