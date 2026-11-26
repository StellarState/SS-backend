import "reflect-metadata";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { DataSource } from "typeorm";
import { User } from "../../src/models/User.model";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { Transaction } from "../../src/models/Transaction.model";
import { KYCVerification } from "../../src/models/KYCVerification.model";
import { Notification } from "../../src/models/Notification.model";
import { KycHistory } from "../../src/models/KycHistory.model";
import { SecondaryListing } from "../../src/models/SecondaryListing.model";
import { Watchlist } from "../../src/models/Watchlist.model";
import { InvoiceStatusHistory } from "../../src/models/InvoiceStatusHistory.model";
import { createInvoiceService } from "../../src/services/invoice.service";
import { createInvoiceRouter } from "../../src/routes/invoice.routes";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { logger } from "../../src/observability/logger";
import type { IPFSService } from "../../src/services/ipfs.service";
import { InvoiceStatus, KYCStatus, UserType } from "../../src/types/enums";

/**
 * GET /api/v1/invoices/:id/history (issue #795) through the real router and
 * service against PostgreSQL. Skipped without DATABASE_URL.
 */
const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const SECRET = "lifecycle-history-test-secret";

describeWithDatabase("Invoice lifecycle history API (issue #795)", () => {
  let dataSource: DataSource;
  let app: express.Application;
  let seller: User;
  let otherSeller: User;
  let invoice: Invoice;
  let quietInvoice: Invoice;
  let sellerToken: string;
  let otherSellerToken: string;
  let adminToken: string;
  /** Ids in the order the API must return them. */
  let expectedOrder: string[];

  const token = (user: { id: string; stellarAddress: string }, userType: UserType) =>
    jwt.sign(
      { sub: user.stellarAddress, userId: user.id, stellarAddress: user.stellarAddress, userType },
      SECRET
    );

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
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
        InvoiceStatusHistory,
      ],
      synchronize: true,
      dropSchema: true,
      logging: false,
    });
    await dataSource.initialize();

    const users = dataSource.getRepository(User);
    seller = await users.save(
      users.create({
        stellarAddress: "GHISTORYSELLER",
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
      })
    );
    otherSeller = await users.save(
      users.create({
        stellarAddress: "GHISTORYOTHER",
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
      })
    );
    const invoices = dataSource.getRepository(Invoice);
    const makeInvoice = (n: string) =>
      invoices.save(
        invoices.create({
          sellerId: seller.id,
          invoiceNumber: n,
          customerName: "History Customer",
          amount: "1000.0000",
          discountRate: "5.00",
          netAmount: "950.0000",
          dueDate: new Date("2099-12-31"),
          status: InvoiceStatus.SETTLED,
        })
      );
    invoice = await makeInvoice("HIST-1");
    quietInvoice = await makeInvoice("HIST-2");

    // Seven transitions. The first three share one transaction and so one
    // now(); two more are a microsecond apart within the same millisecond.
    await dataSource.transaction(async (m) => {
      for (const [from, to, role, actor, trigger, reason] of [
        [InvoiceStatus.DRAFT, InvoiceStatus.PENDING, "seller", seller.id, "seller_submitted", null],
        [
          InvoiceStatus.PENDING,
          InvoiceStatus.REJECTED,
          "admin",
          "GADMINWALLET",
          "admin_rejected",
          "Unreadable scan",
        ],
        [
          InvoiceStatus.REJECTED,
          InvoiceStatus.PENDING,
          "seller",
          seller.stellarAddress,
          "seller_submitted",
          null,
        ],
      ] as const) {
        await m.query(
          `INSERT INTO "invoice_status_history"
             ("invoice_id","from_status","to_status","actor_role","actor_id","trigger","reason")
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [invoice.id, from, to, role, actor, trigger, reason]
        );
      }
    });
    const insertAt = (
      at: string,
      from: string,
      to: string,
      role: string,
      actor: string | null,
      trigger: string
    ) =>
      dataSource.query(
        `INSERT INTO "invoice_status_history"
           ("invoice_id","from_status","to_status","actor_role","actor_id","trigger","created_at")
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [invoice.id, from, to, role, actor, trigger, at]
      );
    await insertAt(
      "2099-01-01T00:00:00.000001Z",
      "pending",
      "approved",
      "admin",
      "GADMINWALLET",
      "admin_approved"
    );
    await insertAt(
      "2099-01-01T00:00:00.000002Z",
      "approved",
      "published",
      "seller",
      seller.id,
      "seller_published"
    );
    await insertAt("2099-01-02T00:00:00Z", "published", "funded", "system", null, "fully_funded");
    await insertAt(
      "2099-01-03T00:00:00Z",
      "funded",
      "settled",
      "system",
      "GSYSTEMJOB",
      "maturity_settled"
    );

    const ordered = (await dataSource.query(
      `SELECT "id" FROM "invoice_status_history" WHERE "invoice_id" = $1 ORDER BY "created_at", "id"`,
      [invoice.id]
    )) as Array<{ id: string }>;
    expectedOrder = ordered.map((r) => r.id);

    const ipfs = {} as IPFSService;
    app = express();
    app.use(express.json());
    app.use(
      "/api/v1/invoices",
      createInvoiceRouter({
        invoiceService: createInvoiceService(dataSource, ipfs),
        config: {
          ipfs: {
            maxFileSizeMB: 10,
            allowedMimeTypes: [],
            uploadRateLimit: { windowMs: 1000, maxUploads: 1 },
          },
          kyc: { skipVerification: true },
        } as never,
      })
    );
    app.use(createErrorMiddleware(logger));

    sellerToken = token(seller, UserType.SELLER);
    otherSellerToken = token(otherSeller, UserType.SELLER);
    adminToken = token(
      { id: "00000000-0000-4000-8000-000000000001", stellarAddress: "GADMIN" },
      UserType.ADMIN
    );
  }, 60_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  const history = (invoiceId: string, auth: string | null, query: Record<string, string> = {}) => {
    const req = request(app).get(`/api/v1/invoices/${invoiceId}/history`).query(query);
    return auth ? req.set("Authorization", `Bearer ${auth}`) : req;
  };

  async function collect(limit: number, auth = sellerToken) {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let pageNo = 0; pageNo < 20; pageNo++) {
      const res = await history(
        invoice.id,
        auth,
        cursor ? { limit: String(limit), cursor } : { limit: String(limit) }
      );
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeLessThanOrEqual(limit);
      ids.push(...res.body.data.map((e: { id: string }) => e.id));
      if (!res.body.meta.hasMore) {
        expect(res.body.meta.nextCursor).toBeNull();
        return ids;
      }
      cursor = res.body.meta.nextCursor;
    }
    throw new Error("pagination did not terminate");
  }

  it.each([1, 2, 3, 7, 100])(
    "pages through every transition exactly once, in order, with limit %i",
    async (limit) => {
      expect(await collect(limit)).toEqual(expectedOrder);
    }
  );

  it("returns the same order on every request (ties broken by id)", async () => {
    const first = await collect(2);
    const second = await collect(3);
    expect(second).toEqual(first);
  });

  it("does not repeat a row whose timestamp has sub-millisecond precision", async () => {
    // Rows 4 and 5 are 1 µs apart; a millisecond cursor would replay row 4.
    const page1 = await history(invoice.id, sellerToken, { limit: "4" });
    const page2 = await history(invoice.id, sellerToken, {
      limit: "4",
      cursor: page1.body.meta.nextCursor,
    });
    const ids = [...page1.body.data, ...page2.body.data].map((e: { id: string }) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expectedOrder);
  });

  it("returns the documented fields, redacting admin and system identities for the seller", async () => {
    const res = await history(invoice.id, sellerToken);
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ limit: 50, hasMore: false, nextCursor: null });
    const rejected = res.body.data.find((e: { trigger: string }) => e.trigger === "admin_rejected");
    expect(rejected).toEqual({
      id: expect.any(String),
      fromStatus: "pending",
      toStatus: "rejected",
      actorRole: "admin",
      actorId: null,
      trigger: "admin_rejected",
      reason: "Unreadable scan",
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    const actorIds = res.body.data.map((e: { actorRole: string; actorId: string | null }) => [
      e.actorRole,
      e.actorId,
    ]);
    expect(actorIds).toEqual([
      expect.anything(),
      expect.anything(),
      expect.anything(),
      ["admin", null],
      ["seller", seller.id],
      ["system", null],
      ["system", null],
    ]);
    // The seller's own entries keep their id or wallet.
    expect(
      res.body.data
        .filter((e: { actorRole: string }) => e.actorRole === "seller")
        .map((e: { actorId: string }) => e.actorId)
        .sort()
    ).toEqual([seller.id, seller.id, seller.stellarAddress].sort());
  });

  it("shows admins every actor", async () => {
    const res = await history(invoice.id, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.data.map((e: { actorId: string | null }) => e.actorId)).toContain(
      "GADMINWALLET"
    );
    expect(res.body.data.map((e: { actorId: string | null }) => e.actorId)).toContain("GSYSTEMJOB");
  });

  it("returns an empty first page for an invoice with no history", async () => {
    const res = await history(quietInvoice.id, sellerToken);
    expect(res.body).toEqual({
      success: true,
      data: [],
      meta: { limit: 50, hasMore: false, nextCursor: null },
    });
  });

  describe("access", () => {
    it("requires authentication", async () => {
      expect((await history(invoice.id, null)).status).toBe(401);
    });

    it("answers another seller exactly as it answers a missing invoice", async () => {
      const foreign = await history(invoice.id, otherSellerToken);
      const missing = await history("11111111-1111-4111-8111-111111111111", otherSellerToken);
      expect(foreign.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
    });

    it("does not reveal history through a cursor either", async () => {
      const page1 = await history(invoice.id, sellerToken, { limit: "2" });
      const res = await history(invoice.id, otherSellerToken, {
        cursor: page1.body.meta.nextCursor,
      });
      expect(res.status).toBe(404);
    });

    it("rejects a cursor taken from a different invoice", async () => {
      const page1 = await history(invoice.id, sellerToken, { limit: "2" });
      const res = await history(quietInvoice.id, sellerToken, {
        cursor: page1.body.meta.nextCursor,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_cursor");
    });

    it.each(["0", "101", "ten"])("rejects limit=%s with 400 invalid_limit", async (limit) => {
      const res = await history(invoice.id, sellerToken, { limit });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_limit");
    });
  });
});
