import { DataSource, Repository, SelectQueryBuilder } from "typeorm";
import { TypeORMMarketplaceRepository } from "../src/repositories/marketplace.repository";
import { Invoice } from "../src/models/Invoice.model";
import { InvoiceStatus } from "../src/types/enums";

describe("TypeORMMarketplaceRepository", () => {
  let mockDataSource: jest.Mocked<DataSource>;
  let mockRepository: jest.Mocked<Repository<Invoice>>;
  let mockQueryBuilder: jest.Mocked<SelectQueryBuilder<Invoice>>;
  let marketplaceRepository: TypeORMMarketplaceRepository;

  beforeEach(() => {
    mockQueryBuilder = {
      createQueryBuilder: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      addOrderBy: jest.fn(),
      getCount: jest.fn(),
      skip: jest.fn(),
      take: jest.fn(),
      getMany: jest.fn(),
    } as any;

    // Chain methods return the query builder for fluent interface
    mockQueryBuilder.where.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.andWhere.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.orderBy.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.addOrderBy.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.skip.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.take.mockReturnValue(mockQueryBuilder);

    mockRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
    } as any;

    mockDataSource = {
      getRepository: jest.fn().mockReturnValue(mockRepository),
    } as any;

    marketplaceRepository = new TypeORMMarketplaceRepository(mockDataSource);
  });

  describe("findPublishedInvoices", () => {
    const mockInvoices = [
      {
        id: "invoice-1",
        invoiceNumber: "INV-001",
        customerName: "Customer A",
        amount: "1000.00",
        discountRate: "5.00",
        netAmount: "950.00",
        dueDate: new Date("2024-12-31"),
        status: InvoiceStatus.PUBLISHED,
        createdAt: new Date("2024-01-01"),
      },
    ] as Invoice[];

    it("should build query with default filters", async () => {
      mockQueryBuilder.getCount.mockResolvedValue(1);
      mockQueryBuilder.getMany.mockResolvedValue(mockInvoices);

      const filters = {
        status: [InvoiceStatus.PUBLISHED],
        sort: "amount" as const,
        sortOrder: "DESC" as const,
      };
      const pagination = { page: 1, limit: 20 };

      await marketplaceRepository.findPublishedInvoices(filters, pagination);

      expect(mockRepository.createQueryBuilder).toHaveBeenCalledWith("invoice");
      expect(mockQueryBuilder.where).toHaveBeenCalledWith("invoice.deletedAt IS NULL");
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith("invoice.status IN (:...statuses)", {
        statuses: [InvoiceStatus.PUBLISHED],
      });
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith("invoice.amount", "DESC");
      expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith("invoice.id", "ASC");
    });

    it("should apply date filter", async () => {
      mockQueryBuilder.getCount.mockResolvedValue(0);
      mockQueryBuilder.getMany.mockResolvedValue([]);

      const dueBefore = new Date("2024-12-01");
      const filters = {
        status: [InvoiceStatus.PUBLISHED],
        dueBefore,
        sort: "due_date" as const,
        sortOrder: "ASC" as const,
      };

      await marketplaceRepository.findPublishedInvoices(filters, { page: 1, limit: 20 });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith("invoice.dueDate <= :dueBefore", {
        dueBefore,
      });
    });

    it("should apply amount filters", async () => {
      mockQueryBuilder.getCount.mockResolvedValue(0);
      mockQueryBuilder.getMany.mockResolvedValue([]);

      const filters = {
        status: [InvoiceStatus.PUBLISHED],
        minAmount: 500,
        maxAmount: 2000,
        sort: "due_date" as const,
        sortOrder: "ASC" as const,
      };

      await marketplaceRepository.findPublishedInvoices(filters, { page: 1, limit: 20 });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "CAST(invoice.amount AS DECIMAL) >= :minAmount",
        { minAmount: 500 },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "CAST(invoice.amount AS DECIMAL) <= :maxAmount",
        { maxAmount: 2000 },
      );
    });

    it("should apply different sort columns", async () => {
      mockQueryBuilder.getCount.mockResolvedValue(0);
      mockQueryBuilder.getMany.mockResolvedValue([]);

      const testCases = [
        { sort: "due_date", expected: "invoice.dueDate" },
        { sort: "discount_rate", expected: "invoice.discountRate" },
        { sort: "amount", expected: "invoice.amount" },
        { sort: "created_at", expected: "invoice.createdAt" },
      ];

      for (const testCase of testCases) {
        mockQueryBuilder.orderBy.mockClear();

        const filters = {
          status: [InvoiceStatus.PUBLISHED],
          sort: testCase.sort as any,
          sortOrder: "DESC" as const,
        };

        await marketplaceRepository.findPublishedInvoices(filters, { page: 1, limit: 20 });

        expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith(testCase.expected, "DESC");
      }
    });

    it("should apply pagination correctly", async () => {
      mockQueryBuilder.getCount.mockResolvedValue(50);
      mockQueryBuilder.getMany.mockResolvedValue([]);

      const filters = {
        status: [InvoiceStatus.PUBLISHED],
        sort: "amount" as const,
        sortOrder: "ASC" as const,
      };
      const pagination = { page: 3, limit: 10 };

      await marketplaceRepository.findPublishedInvoices(filters, pagination);

      expect(mockQueryBuilder.skip).toHaveBeenCalledWith(20); // (page - 1) * limit
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(10);
    });

    it("should handle multiple statuses", async () => {
      mockQueryBuilder.getCount.mockResolvedValue(0);
      mockQueryBuilder.getMany.mockResolvedValue([]);

      const filters = {
        status: [InvoiceStatus.PUBLISHED, InvoiceStatus.FUNDED],
        sort: "due_date" as const,
        sortOrder: "ASC" as const,
      };

      await marketplaceRepository.findPublishedInvoices(filters, { page: 1, limit: 20 });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith("invoice.status IN (:...statuses)", {
        statuses: [InvoiceStatus.PUBLISHED, InvoiceStatus.FUNDED],
      });
    });

    it("should not apply optional filters when not provided", async () => {
      mockQueryBuilder.getCount.mockResolvedValue(0);
      mockQueryBuilder.getMany.mockResolvedValue([]);

      const filters = {
        sort: "amount" as const,
        sortOrder: "ASC" as const,
        // No status, dueBefore, minAmount, maxAmount provided
      };

      await marketplaceRepository.findPublishedInvoices(filters, { page: 1, limit: 20 });

      // Should only have the base where clause for deleted_at
      expect(mockQueryBuilder.where).toHaveBeenCalledTimes(1);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith("invoice.deletedAt IS NULL");
      
      // Should not have additional where clauses for optional filters (except default status)
      const andWhereCalls = mockQueryBuilder.andWhere.mock.calls;
      expect(andWhereCalls.some(call => typeof call[0] === 'string' && call[0].includes("dueDate"))).toBe(false);
      expect(andWhereCalls.some(call => typeof call[0] === 'string' && call[0].includes("amount"))).toBe(false);
      
      // Status filter should be applied with default value
      expect(andWhereCalls.some(call => typeof call[0] === 'string' && call[0].includes("status"))).toBe(true);
    });

    it("should return both invoices and total count", async () => {
      mockQueryBuilder.getCount.mockResolvedValue(25);
      mockQueryBuilder.getMany.mockResolvedValue(mockInvoices);

      const result = await marketplaceRepository.findPublishedInvoices(
        { status: [InvoiceStatus.PUBLISHED], sort: "amount", sortOrder: "DESC" },
        { page: 1, limit: 20 },
      );

      expect(result.total).toBe(25);
      expect(result.invoices).toHaveLength(1);
      expect(mockQueryBuilder.getCount).toHaveBeenCalled();
      expect(mockQueryBuilder.getMany).toHaveBeenCalled();
    });
  });
});