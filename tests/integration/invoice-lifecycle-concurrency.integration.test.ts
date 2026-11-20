import crypto from "crypto";
import { DataSource } from "typeorm";
import { InvoiceService } from "../../src/services/invoice.service";
import { Invoice } from "../../src/models/Invoice.model";
import { User } from "../../src/models/User.model";
import { InvoiceStatusHistory } from "../../src/models/InvoiceStatusHistory.model";
import { SettlementIntent } from "../../src/models/SettlementIntent.model";
import { InvoiceDocument } from "../../src/models/InvoiceDocument.model";
import { InvoiceStatus, KYCStatus, UserType } from "../../src/types/enums";
import type { IPFSService } from "../../src/services/ipfs.service";
import { ServiceError } from "../../src/utils/service-error";

/**
 * Serialized Fake DataSource simulating pessimistic row locks and serialized
 * transactions in memory.
 */
function createSerializedFakeDataSource(invoice: Invoice, seller: User) {
  const invoices = new Map<string, Invoice>([[invoice.id, { ...invoice } as Invoice]]);
  const users = new Map<string, User>([[seller.id, { ...seller } as User]]);
  const history: InvoiceStatusHistory[] = [];

  const manager = {
    createQueryBuilder: (entity: unknown, _alias?: string) => {
      let targetId: string | undefined;
      const builder = {
        setLock: () => builder,
        leftJoinAndSelect: () => builder,
        where: (_clause: string, params: { id: string }) => {
          targetId = params.id;
          return builder;
        },
        getOne: async () => {
          if (!targetId) return null;
          if (entity === Invoice) {
            const inv = invoices.get(targetId);
            if (!inv) return null;
            return { ...inv, seller: users.get(inv.sellerId) } as Invoice;
          }
          return null;
        },
      };
      return builder;
    },
    findOne: async (entity: unknown, options: { where: { id?: string; invoiceId?: string }; relations?: string[] }) => {
      if (entity === Invoice && options?.where?.id) {
        const inv = invoices.get(options.where.id);
        if (!inv) return null;
        return { ...inv, seller: users.get(inv.sellerId) } as Invoice;
      }
      if (entity === SettlementIntent) {
        return null;
      }
      return null;
    },
    save: async (entityOrTarget: unknown, maybeData?: unknown) => {
      const entityClass = maybeData ? entityOrTarget : undefined;
      const data = maybeData ?? entityOrTarget;

      if (entityClass === InvoiceStatusHistory || (!entityClass && (data as any).fromStatus)) {
        const record = {
          id: crypto.randomUUID(),
          createdAt: new Date(),
          ...(data as object),
        } as InvoiceStatusHistory;
        history.push(record);
        return record;
      }

      const inv = data as Invoice;
      if (inv && inv.id) {
        invoices.set(inv.id, { ...inv });
      }
      return inv;
    },
    getRepository: (entity: unknown) => {
      if (entity === InvoiceStatusHistory) {
        return {
          find: async (options: { where: { invoiceId: string } }) =>
            history.filter((h) => h.invoiceId === options.where.invoiceId),
        };
      }
      if (entity === InvoiceDocument) {
        return {
          softDelete: jest.fn().mockResolvedValue({ affected: 0 }),
        };
      }
      return manager;
    },
  };

  let txChain: Promise<unknown> = Promise.resolve();

  const dataSource = {
    transaction: (callback: (em: typeof manager) => Promise<unknown>) => {
      const next = txChain.then(() => callback(manager));
      txChain = next.catch(() => {});
      return next;
    },
    getRepository: (entity: unknown) => manager.getRepository(entity),
  } as unknown as DataSource;

  return { dataSource, invoices, users, history };
}

function createInvoice(sellerId: string, overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: crypto.randomUUID(),
    sellerId,
    invoiceNumber: `INV-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    customerName: "Acme Corporation",
    issuerName: "Issuer Corp",
    description: "Initial description",
    amount: "1000.0000",
    discountRate: "5.00",
    netAmount: "950.0000",
    dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    ipfsHash: "QmConcurrencyDocHash123456789",
    riskScore: "1.50",
    status: InvoiceStatus.DRAFT,
    smartContractId: null,
    rejectionReason: null,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    seller: undefined as unknown as User,
    ...overrides,
  } as Invoice;
}

function noopIpfsService(): IPFSService {
  return {
    uploadFile: async () => ({ hash: "QmTest", size: 0, url: "https://ipfs.test" }),
  } as unknown as IPFSService;
}

describe("Invoice lifecycle concurrency and pessimistic locking (issue #732)", () => {
  const sellerId = crypto.randomUUID();
  const sellerUser: User = {
    id: sellerId,
    stellarAddress: "GSELLER1234567890CONCURRENCYTEST",
    kycStatus: KYCStatus.APPROVED,
    userType: UserType.SELLER,
  } as User;

  describe("Simulated concurrent operations with serialized transactions", () => {
    it("racing approval and rejection produces exactly one valid decision and one history row", async () => {
      const invoice = createInvoice(sellerId, { status: InvoiceStatus.PENDING });
      const { dataSource, invoices, history } = createSerializedFakeDataSource(invoice, sellerUser);

      const repo = {
        findOne: async (options: { where: { id: string } }) => {
          const inv = invoices.get(options.where.id);
          return inv ? ({ ...inv, seller: sellerUser } as Invoice) : null;
        },
        save: async (inv: Invoice) => {
          invoices.set(inv.id, { ...inv });
          return inv;
        },
      } as any;

      const service = new InvoiceService({
        invoiceRepository: repo,
        ipfsService: noopIpfsService(),
        dataSource,
      });

      // Both callers start from the initial-read boundary where status is PENDING
      const [approvalResult, rejectionResult] = await Promise.allSettled([
        service.approveInvoice({ invoiceId: invoice.id, actorId: "admin-1" }),
        service.rejectInvoice({
          invoiceId: invoice.id,
          actorId: "admin-2",
          rejectionReason: "Invalid documents",
        }),
      ]);

      const fulfilled = [approvalResult, rejectionResult].filter((r) => r.status === "fulfilled");
      const rejected = [approvalResult, rejectionResult].filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // The losing request fails with invalid_status_transition
      const failure = (rejected[0] as PromiseRejectedResult).reason;
      expect(failure).toBeInstanceOf(ServiceError);
      expect(failure.code).toBe("invalid_status_transition");

      // Exactly one status history row is written, recording fromStatus: PENDING
      expect(history).toHaveLength(1);
      expect(history[0].invoiceId).toBe(invoice.id);
      expect(history[0].fromStatus).toBe(InvoiceStatus.PENDING);

      // Persisted row matches winner and loser did not overwrite
      const finalInvoice = invoices.get(invoice.id)!;
      if (approvalResult.status === "fulfilled") {
        expect(finalInvoice.status).toBe(InvoiceStatus.PUBLISHED);
        expect(finalInvoice.rejectionReason).toBeNull();
      } else {
        expect(finalInvoice.status).toBe(InvoiceStatus.REJECTED);
        expect(finalInvoice.rejectionReason).toBe("Invalid documents");
      }
    });

    it("editing racing with publication cannot modify a published invoice", async () => {
      const invoice = createInvoice(sellerId, { status: InvoiceStatus.DRAFT, amount: "1000.0000" });
      const { dataSource, invoices } = createSerializedFakeDataSource(invoice, sellerUser);

      const repo = {
        findOne: async (options: { where: { id: string } }) => {
          const inv = invoices.get(options.where.id);
          return inv ? ({ ...inv, seller: sellerUser } as Invoice) : null;
        },
        save: async (inv: Invoice) => {
          invoices.set(inv.id, { ...inv });
          return inv;
        },
      } as any;

      const service = new InvoiceService({
        invoiceRepository: repo,
        ipfsService: noopIpfsService(),
        dataSource,
      });

      // Both operations coordinate at the initial-read boundary (invoice is DRAFT)
      // Publication runs, followed by an update attempting to alter financial fields
      const publishPromise = service.publishInvoice({ invoiceId: invoice.id, sellerId });
      const editPromise = service.updateInvoice({
        invoiceId: invoice.id,
        sellerId,
        amount: "5000.0000",
        customerName: "Malicious Tamperer",
      });

      const [pubResult, editResult] = await Promise.allSettled([publishPromise, editPromise]);

      // Publication must succeed
      expect(pubResult.status).toBe("fulfilled");

      // Edit racing after publication must fail
      expect(editResult.status).toBe("rejected");
      const editError = (editResult as PromiseRejectedResult).reason;
      expect(editError).toBeInstanceOf(ServiceError);
      expect(editError.code).toBe("invalid_invoice_status");

      // Published invoice maintains its financial fields intact
      const persisted = invoices.get(invoice.id)!;
      expect(persisted.status).toBe(InvoiceStatus.PUBLISHED);
      expect(persisted.amount).toBe("1000.0000");
      expect(persisted.customerName).toBe("Acme Corporation");
    });

    it("concurrent repeat publication creates no duplicate transition history", async () => {
      const invoice = createInvoice(sellerId, { status: InvoiceStatus.DRAFT });
      const { dataSource, invoices, history } = createSerializedFakeDataSource(invoice, sellerUser);

      const repo = {
        findOne: async (options: { where: { id: string } }) => {
          const inv = invoices.get(options.where.id);
          return inv ? ({ ...inv, seller: sellerUser } as Invoice) : null;
        },
        save: async (inv: Invoice) => {
          invoices.set(inv.id, { ...inv });
          return inv;
        },
      } as any;

      const service = new InvoiceService({
        invoiceRepository: repo,
        ipfsService: noopIpfsService(),
        dataSource,
      });

      const [pub1, pub2] = await Promise.allSettled([
        service.publishInvoice({ invoiceId: invoice.id, sellerId }),
        service.publishInvoice({ invoiceId: invoice.id, sellerId }),
      ]);

      const fulfilled = [pub1, pub2].filter((r) => r.status === "fulfilled");
      const rejected = [pub1, pub2].filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // Exactly one history row is recorded
      expect(history).toHaveLength(1);
      expect(history[0].fromStatus).toBe(InvoiceStatus.DRAFT);
      expect(history[0].toStatus).toBe(InvoiceStatus.PUBLISHED);
    });
  });

  // Real PostgreSQL integration test when DATABASE_URL is configured
  const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
  describeIfDb("PostgreSQL coordination at the initial-read boundary", () => {
    let pgDataSource: DataSource;

    beforeAll(async () => {
      pgDataSource = new DataSource({
        type: "postgres",
        url: process.env.DATABASE_URL,
        entities: [Invoice, User, InvoiceStatusHistory, InvoiceDocument],
        synchronize: true,
        dropSchema: true,
        logging: false,
      });
      await pgDataSource.initialize();
    });

    afterAll(async () => {
      if (pgDataSource?.isInitialized) {
        await pgDataSource.destroy();
      }
    });

    it("races approval and rejection against PostgreSQL with row locking", async () => {
      const userRepo = pgDataSource.getRepository(User);
      const invoiceRepo = pgDataSource.getRepository(Invoice);
      const historyRepo = pgDataSource.getRepository(InvoiceStatusHistory);

      const seller = await userRepo.save(
        userRepo.create({
          stellarAddress: "GSELLERPG1234567890",
          kycStatus: KYCStatus.APPROVED,
          userType: UserType.SELLER,
        })
      );

      const inv = await invoiceRepo.save(
        invoiceRepo.create({
          sellerId: seller.id,
          invoiceNumber: `INV-PG-${Date.now()}`,
          customerName: "Postgres Customer",
          amount: "2000.0000",
          discountRate: "5.00",
          netAmount: "1900.0000",
          dueDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
          ipfsHash: "QmPostgresDoc",
          status: InvoiceStatus.PENDING,
        })
      );

      const service = new InvoiceService({
        invoiceRepository: invoiceRepo as any,
        ipfsService: noopIpfsService(),
        dataSource: pgDataSource,
      });

      // Both read at the initial-read boundary before transactions execute
      const [approval, rejection] = await Promise.allSettled([
        service.approveInvoice({ invoiceId: inv.id, actorId: "admin-1" }),
        service.rejectInvoice({
          invoiceId: inv.id,
          actorId: "admin-2",
          rejectionReason: "PG rejected",
        }),
      ]);

      const fulfilled = [approval, rejection].filter((r) => r.status === "fulfilled");
      const rejected = [approval, rejection].filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rows = await historyRepo.find({ where: { invoiceId: inv.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].fromStatus).toBe(InvoiceStatus.PENDING);
    });
  });
});
