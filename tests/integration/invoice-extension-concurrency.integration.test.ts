import "reflect-metadata";
import { DataSource, Repository } from "typeorm";
import { User } from "../../src/models/User.model";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { Transaction } from "../../src/models/Transaction.model";
import { KYCVerification } from "../../src/models/KYCVerification.model";
import { Notification } from "../../src/models/Notification.model";
import { KycHistory } from "../../src/models/KycHistory.model";
import { SecondaryListing } from "../../src/models/SecondaryListing.model";
import { Watchlist } from "../../src/models/Watchlist.model";
import { InvoiceExtensionRequest } from "../../src/models/InvoiceExtensionRequest.model";
import {
  InvoiceExtensionService,
  PENDING_EXTENSION_UNIQUE_INDEX,
} from "../../src/services/invoice-extension.service";
import { EnforceSinglePendingExtensionRequest1796100000000 } from "../../src/migrations/1796100000000-EnforceSinglePendingExtensionRequest";
import { ExtensionRequestStatus, InvoiceStatus, KYCStatus, UserType } from "../../src/types/enums";

/**
 * Issue #734 — one pending funding extension per invoice under concurrent
 * submissions, against a real PostgreSQL database (set DATABASE_URL; the
 * suite is skipped without it, like the other integration suites).
 */
const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("Pending extension invariant under concurrency (issue #734)", () => {
  let dataSource: DataSource;
  let service: InvoiceExtensionService;
  let seller: User;
  let invoiceCounter = 0;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: "postgres",
      url: databaseUrl,
      entities: [
        User,
        Invoice,
        Investment,
        Transaction,
        KYCVerification,
        Notification,
        KycHistory,
        SecondaryListing,
        Watchlist,
        InvoiceExtensionRequest,
      ],
      synchronize: true,
      dropSchema: true,
      logging: false,
      extra: { max: 20 },
    });
    await dataSource.initialize();
    service = new InvoiceExtensionService(dataSource);

    const users = dataSource.getRepository(User);
    seller = await users.save(
      users.create({
        stellarAddress: "GEXTENSIONCONCURRENCYSELLER0000000000000000000000000001",
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
      })
    );
  }, 60_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  async function createInvoice(): Promise<Invoice> {
    invoiceCounter += 1;
    const invoices = dataSource.getRepository(Invoice);
    return invoices.save(
      invoices.create({
        sellerId: seller.id,
        invoiceNumber: `EXT-CONC-${invoiceCounter}`,
        customerName: "Concurrency Customer",
        amount: "1000.0000",
        discountRate: "5.00",
        netAmount: "950.0000",
        dueDate: new Date("2099-12-31"),
        fundingDeadline: new Date("2099-01-01T00:00:00.000Z"),
        status: InvoiceStatus.PUBLISHED,
      })
    );
  }

  const proposal = (invoiceId: string, day: number) => ({
    invoiceId,
    sellerId: seller.id,
    proposedDeadline: new Date(`2099-02-${String(day).padStart(2, "0")}T00:00:00.000Z`),
    reason: `attempt ${day}`,
  });

  /**
   * Opens every pooled connection and then widens the gap between a
   * request's "is anything pending?" read and its insert, so all racers read
   * before any of them writes. Without this the pool connects lazily and the
   * requests effectively run one after another, which would let the old,
   * unprotected code pass.
   */
  async function forceRaceWindow(): Promise<jest.SpyInstance> {
    await Promise.all(Array.from({ length: 15 }, () => dataSource.query("SELECT pg_sleep(0.02)")));
    const original = Repository.prototype.findOne;
    return jest.spyOn(Repository.prototype, "findOne").mockImplementation(async function (
      this: Repository<object>,
      options
    ) {
      const result = await original.call(this, options);
      const where = (options as { where?: { status?: unknown } }).where;
      if (this.metadata.target === InvoiceExtensionRequest && where?.status === "pending") {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return result;
    });
  }

  afterEach(() => jest.restoreAllMocks());

  const pendingRows = (invoiceId: string) =>
    dataSource
      .getRepository(InvoiceExtensionRequest)
      .find({ where: { invoiceId, status: ExtensionRequestStatus.PENDING } });

  it("creates exactly one pending row when many proposals race, and every loser gets 409 EXTENSION_PENDING", async () => {
    const invoice = await createInvoice();
    const attempts = Array.from({ length: 12 }, (_, i) => proposal(invoice.id, i + 1));
    const spy = await forceRaceWindow();

    const results = await Promise.allSettled(attempts.map((a) => service.requestExtension(a)));

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<InvoiceExtensionRequest> => r.status === "fulfilled"
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(11);
    // Every racer did reach the pending check, so this was a real race.
    expect(
      spy.mock.calls.filter(
        ([o]) => (o as { where?: { status?: unknown } }).where?.status === "pending"
      )
    ).toHaveLength(12);
    for (const r of rejected) {
      expect(r.reason).toMatchObject({ code: "EXTENSION_PENDING", statusCode: 409 });
    }

    // The stored row is the winner's, untouched by any loser.
    const rows = await pendingRows(invoice.id);
    expect(rows).toHaveLength(1);
    const winner = fulfilled[0].value;
    expect(rows[0].id).toBe(winner.id);
    expect(rows[0].proposedDeadline.toISOString()).toBe(winner.proposedDeadline.toISOString());
    expect(rows[0].reason).toBe(winner.reason);
  });

  it("lets different invoices create proposals concurrently", async () => {
    const invoices = await Promise.all(Array.from({ length: 6 }, () => createInvoice()));
    await forceRaceWindow();

    const results = await Promise.allSettled(
      invoices.map((inv, i) => service.requestExtension(proposal(inv.id, i + 1)))
    );

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    for (const inv of invoices) {
      expect(await pendingRows(inv.id)).toHaveLength(1);
    }
  });

  it("the database itself rejects a second pending row, even from a writer that skips the service checks", async () => {
    const invoice = await createInvoice();
    const insert = (manager: DataSource["manager"], day: number) =>
      manager.query(
        `INSERT INTO "invoice_extension_requests"
           ("invoice_id", "requested_by", "proposed_deadline", "reason", "status")
         VALUES ($1, $2, $3, $4, 'pending')`,
        [invoice.id, seller.id, `2099-03-${String(day).padStart(2, "0")}T00:00:00Z`, `raw ${day}`]
      );

    // Two open transactions insert at the same time with no locking: the
    // second blocks on the index until the first commits, then fails.
    const runner1 = dataSource.createQueryRunner();
    const runner2 = dataSource.createQueryRunner();
    await runner1.startTransaction();
    await runner2.startTransaction();
    try {
      await insert(runner1.manager, 1);
      const second = insert(runner2.manager, 2);
      await runner1.commitTransaction();
      await expect(second).rejects.toMatchObject({
        driverError: expect.objectContaining({
          code: "23505",
          constraint: PENDING_EXTENSION_UNIQUE_INDEX,
        }),
      });
      await runner2.rollbackTransaction();
    } finally {
      await runner1.release();
      await runner2.release();
    }

    const rows = await pendingRows(invoice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("raw 1");
  });

  it("keeps reviewed requests for audit and accepts a later proposal after review", async () => {
    const invoice = await createInvoice();

    const first = await service.requestExtension(proposal(invoice.id, 1));
    await service.reviewExtension({
      invoiceId: invoice.id,
      requestId: first.id,
      decision: "reject",
      reviewedBy: "GADMIN",
    });

    const second = await service.requestExtension(proposal(invoice.id, 2));
    await service.reviewExtension({
      invoiceId: invoice.id,
      requestId: second.id,
      decision: "approve",
      reviewedBy: "GADMIN",
    });

    // A third proposal must extend past the newly approved deadline.
    const third = await service.requestExtension(proposal(invoice.id, 3));

    const all = await dataSource
      .getRepository(InvoiceExtensionRequest)
      .find({ where: { invoiceId: invoice.id }, order: { createdAt: "ASC" } });
    expect(all.map((r) => [r.id, r.status])).toEqual([
      [first.id, ExtensionRequestStatus.REJECTED],
      [second.id, ExtensionRequestStatus.APPROVED],
      [third.id, ExtensionRequestStatus.PENDING],
    ]);
  });

  it("only one of two concurrent approvals of the same request takes effect", async () => {
    const invoice = await createInvoice();
    const req = await service.requestExtension(proposal(invoice.id, 5));

    const results = await Promise.allSettled([
      service.reviewExtension({
        invoiceId: invoice.id,
        requestId: req.id,
        decision: "approve",
        reviewedBy: "GADMIN-A",
      }),
      service.reviewExtension({
        invoiceId: invoice.id,
        requestId: req.id,
        decision: "reject",
        reviewedBy: "GADMIN-B",
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
    expect(loser.reason).toMatchObject({ code: "EXTENSION_NOT_PENDING", statusCode: 409 });
  });

  it("migration resolves existing duplicate pending rows before building the index", async () => {
    const invoice = await createInvoice();
    const runner = dataSource.createQueryRunner();
    try {
      await runner.query(`DROP INDEX IF EXISTS "${PENDING_EXTENSION_UNIQUE_INDEX}"`);
      for (const [day, createdAt] of [
        [2, "2026-01-02T00:00:00Z"],
        [1, "2026-01-01T00:00:00Z"],
        [3, "2026-01-03T00:00:00Z"],
      ] as const) {
        await runner.query(
          `INSERT INTO "invoice_extension_requests"
             ("invoice_id", "requested_by", "proposed_deadline", "reason", "status", "created_at")
           VALUES ($1, $2, $3, $4, 'pending', $5)`,
          [invoice.id, seller.id, `2099-04-0${day}T00:00:00Z`, `legacy ${day}`, createdAt]
        );
      }

      await new EnforceSinglePendingExtensionRequest1796100000000().up(runner);

      const rows = await dataSource
        .getRepository(InvoiceExtensionRequest)
        .find({ where: { invoiceId: invoice.id }, order: { createdAt: "ASC" } });
      expect(rows.map((r) => [r.reason, r.status])).toEqual([
        ["legacy 1", ExtensionRequestStatus.PENDING],
        ["legacy 2", ExtensionRequestStatus.REJECTED],
        ["legacy 3", ExtensionRequestStatus.REJECTED],
      ]);
      expect(rows[1].reviewNote).toMatch(/Superseded duplicate/);

      const indexes = await runner.query(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [
        PENDING_EXTENSION_UNIQUE_INDEX,
      ]);
      expect(indexes).toHaveLength(1);
      expect(indexes[0].indexdef).toMatch(/UNIQUE INDEX .*\(invoice_id\) WHERE/);

      // down() drops only the index; up() can run again.
      const migration = new EnforceSinglePendingExtensionRequest1796100000000();
      await migration.down(runner);
      expect(
        await runner.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [
          PENDING_EXTENSION_UNIQUE_INDEX,
        ])
      ).toHaveLength(0);
      await migration.up(runner);
      expect(
        await runner.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [
          PENDING_EXTENSION_UNIQUE_INDEX,
        ])
      ).toHaveLength(1);
    } finally {
      await runner.release();
    }
  });
});
