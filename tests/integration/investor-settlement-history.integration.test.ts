import "reflect-metadata";
import path from "path";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { DataSource } from "typeorm";
import { User } from "../../src/models/User.model";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { createSettlementService } from "../../src/services/settlement.service";
import { createInvestorSettlementHistoryService } from "../../src/services/investor-settlement-history.service";
import { createInvestorRouter } from "../../src/routes/investor.routes";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { logger } from "../../src/observability/logger";
import type { AuthService } from "../../src/services/auth.service";
import { InvestmentStatus, InvoiceStatus, KYCStatus, UserType } from "../../src/types/enums";

/**
 * GET /api/v1/investors/:wallet/settlements and /export (issue #782), with
 * settlements produced by the real SettlementService (2% platform fee)
 * against PostgreSQL. Skipped without DATABASE_URL.
 */
const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const SECRET = "settlement-history-test-secret";

describeWithDatabase("Investor settlement history API (issue #782)", () => {
  let dataSource: DataSource;
  let app: express.Application;
  let seller: User;
  let alice: User;
  let bob: User;
  let carol: User;
  let aliceToken: string;
  let carolToken: string;
  let invoiceCounter = 0;

  const tokenFor = (user: User) =>
    jwt.sign(
      {
        sub: user.stellarAddress,
        userId: user.id,
        stellarAddress: user.stellarAddress,
        userType: user.userType,
      },
      SECRET
    );

  // The router's auth middleware only needs to resolve the bearer token.
  const authService = {
    getCurrentUser: async (token: string) => {
      const claims = jwt.verify(token, SECRET) as { userId: string };
      const user = await dataSource.getRepository(User).findOneByOrFail({ id: claims.userId });
      return user;
    },
  } as unknown as AuthService;

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    dataSource = new DataSource({
      type: "postgres",
      url: databaseUrl,
      entities: [path.join(__dirname, "../../src/models/*.model.ts")],
      synchronize: true,
      dropSchema: true,
      logging: false,
    });
    await dataSource.initialize();

    const users = dataSource.getRepository(User);
    const makeUser = (address: string, userType: UserType) =>
      users.save(
        users.create({ stellarAddress: address, userType, kycStatus: KYCStatus.APPROVED })
      );
    seller = await makeUser("GSETTLEHISTSELLER", UserType.SELLER);
    alice = await makeUser("GSETTLEHISTALICE", UserType.INVESTOR);
    bob = await makeUser("GSETTLEHISTBOB", UserType.INVESTOR);
    carol = await makeUser("GSETTLEHISTCAROL", UserType.INVESTOR);

    const settlement = createSettlementService(dataSource, undefined, {
      feeRecipient: "GFEERECIPIENT",
      feeBps: 200,
    });

    /** Funds an invoice with the given holdings and settles it for `proceeds`. */
    const settle = async (
      category: string | null,
      holdings: Array<[User, string]>,
      proceeds: string
    ) => {
      invoiceCounter += 1;
      const invoices = dataSource.getRepository(Invoice);
      const invoice = await invoices.save(
        invoices.create({
          sellerId: seller.id,
          invoiceNumber: `SETTLE-HIST-${invoiceCounter}`,
          customerName: "Customer",
          amount: "1000.0000",
          discountRate: "5.00",
          netAmount: "950.0000",
          dueDate: new Date("2099-12-31"),
          status: InvoiceStatus.FUNDED,
          category,
        })
      );
      const investments = dataSource.getRepository(Investment);
      for (const [investor, amount] of holdings) {
        await investments.save(
          investments.create({
            invoiceId: invoice.id,
            investorId: investor.id,
            investorWallet: investor.stellarAddress,
            investmentAmount: amount,
            expectedReturn: amount,
            status: InvestmentStatus.CONFIRMED,
          })
        );
      }
      await settlement.settleInvoice({
        invoiceId: invoice.id,
        proceeds,
        actorWallet: "system:test",
        systemTrigger: "system_matured" as never,
      });
      return invoice;
    };

    // Alice: 25% of a profitable logistics invoice, 50% of a loss-making
    // retail one, sole holder of a third. Bob shares the first two.
    await settle(
      "logistics",
      [
        [alice, "250.0000"],
        [bob, "750.0000"],
      ],
      "1100.0000"
    );
    await settle(
      "Retail",
      [
        [alice, "500.0000"],
        [bob, "500.0000"],
      ],
      "800.0000"
    );
    await settle(null, [[alice, "100.0000"]], "103.0000");

    // Spread the settlement times so the date filters have something to cut.
    const at = [
      "2026-10-05T12:00:00.000001Z",
      "2026-11-10T08:00:00.000002Z",
      "2026-11-20T23:59:59.999999Z",
    ];
    const returns = (await dataSource.query(
      `SELECT ir."id", inv."invoice_number" FROM "investor_returns" ir
       JOIN "invoices" inv ON inv."id" = ir."invoice_id" ORDER BY inv."invoice_number"`
    )) as Array<{ id: string; invoice_number: string }>;
    for (const r of returns) {
      const n = Number(r.invoice_number.split("-").pop()) - 1;
      await dataSource.query(`UPDATE "investor_returns" SET "created_at" = $1 WHERE "id" = $2`, [
        at[n],
        r.id,
      ]);
    }

    app = express();
    app.use(express.json());
    app.use(
      "/api/v1/investors",
      createInvestorRouter({
        authService,
        settlementHistoryService: createInvestorSettlementHistoryService(dataSource),
      })
    );
    app.use(createErrorMiddleware(logger));

    aliceToken = tokenFor(alice);
    carolToken = tokenFor(carol);
  }, 120_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  const list = (wallet: string, auth: string | null, query: Record<string, string> = {}) => {
    const req = request(app).get(`/api/v1/investors/${wallet}/settlements`).query(query);
    return auth ? req.set("Authorization", `Bearer ${auth}`) : req;
  };

  it("returns one record per settled investment, newest first, with correct returns", async () => {
    const res = await list(alice.stellarAddress, aliceToken);
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ limit: 20, hasMore: false, nextCursor: null });
    expect(res.body.data.map((r: { invoice_number: string }) => r.invoice_number)).toEqual([
      "SETTLE-HIST-3",
      "SETTLE-HIST-2",
      "SETTLE-HIST-1",
    ]);

    const [sole, loss, profit] = res.body.data;
    // 1100 proceeds, 22 fee, 1078 distributed; Alice holds 25%.
    expect(profit).toEqual({
      invoice_id: expect.any(String),
      invoice_number: "SETTLE-HIST-1",
      invoice_type: "logistics",
      settled_at: "2026-10-05T12:00:00.000Z",
      fractions_held: "0.250000",
      invested_amount: "250.0000",
      payout_amount: "269.5000",
      principal_returned: "250.0000",
      yield_earned: "25.0000",
      fees: "5.5000",
      fee_data_available: true,
      net_return_usd: "19.5000",
      net_return_pct: "7.8000",
    });
    // 800 proceeds, 16 fee, 784 distributed; Alice holds 50%.
    expect(loss).toMatchObject({
      invoice_type: "Retail",
      fractions_held: "0.500000",
      payout_amount: "392.0000",
      principal_returned: "400.0000",
      yield_earned: "0.0000",
      fees: "8.0000",
      net_return_usd: "-108.0000",
      net_return_pct: "-21.6000",
    });
    // 103 proceeds, 2.06 fee, 100.94 paid.
    expect(sole).toMatchObject({
      invoice_type: null,
      fractions_held: "1.000000",
      payout_amount: "100.9400",
      fees: "2.0600",
      yield_earned: "3.0000",
      net_return_usd: "0.9400",
      net_return_pct: "0.9400",
    });
  });

  it("agrees with what settlement actually paid", async () => {
    const res = await list(alice.stellarAddress, aliceToken);
    const paid = (await dataSource.query(
      `SELECT inv."invoice_number", i."actual_return"::text AS actual
       FROM "investments" i JOIN "invoices" inv ON inv."id" = i."invoice_id"
       WHERE i."investor_id" = $1`,
      [alice.id]
    )) as Array<{ invoice_number: string; actual: string }>;
    for (const record of res.body.data) {
      const actual = paid.find((p) => p.invoice_number === record.invoice_number)!.actual;
      expect(Number(record.payout_amount)).toBe(Number(actual));
    }
  });

  it("pages with the cursor without gaps or repeats", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await list(
        alice.stellarAddress,
        aliceToken,
        cursor ? { limit: "1", cursor } : { limit: "1" }
      );
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((r: { invoice_number: string }) => r.invoice_number));
      if (!res.body.meta.hasMore) break;
      cursor = res.body.meta.nextCursor;
    }
    expect(seen).toEqual(["SETTLE-HIST-3", "SETTLE-HIST-2", "SETTLE-HIST-1"]);
  });

  it("does not skip a settlement one microsecond older than the page boundary", async () => {
    // Move SETTLE-HIST-1 to 1 µs before SETTLE-HIST-2 (same millisecond); a
    // millisecond-precision cursor would compare past it and drop it.
    const [{ id, created_at }] = await dataSource.query(
      `SELECT ir."id", ir."created_at"::text AS created_at FROM "investor_returns" ir
       JOIN "invoices" inv ON inv."id" = ir."invoice_id"
       WHERE inv."invoice_number" = 'SETTLE-HIST-1' AND ir."investor_id" = $1`,
      [alice.id]
    );
    await dataSource.query(`UPDATE "investor_returns" SET "created_at" = $1 WHERE "id" = $2`, [
      "2026-11-10T08:00:00.000001Z",
      id,
    ]);
    try {
      const page1 = await list(alice.stellarAddress, aliceToken, { limit: "2" });
      const page2 = await list(alice.stellarAddress, aliceToken, {
        limit: "2",
        cursor: page1.body.meta.nextCursor,
      });
      expect(
        [...page1.body.data, ...page2.body.data].map(
          (r: { invoice_number: string }) => r.invoice_number
        )
      ).toEqual(["SETTLE-HIST-3", "SETTLE-HIST-2", "SETTLE-HIST-1"]);
    } finally {
      await dataSource.query(`UPDATE "investor_returns" SET "created_at" = $1 WHERE "id" = $2`, [
        created_at,
        id,
      ]);
    }
  });

  it.each([
    [{ from_date: "2026-11-01" }, ["SETTLE-HIST-3", "SETTLE-HIST-2"]],
    [{ to_date: "2026-11-10" }, ["SETTLE-HIST-2", "SETTLE-HIST-1"]],
    // A bare to_date includes the whole day, down to its last microsecond.
    [{ from_date: "2026-11-20", to_date: "2026-11-20" }, ["SETTLE-HIST-3"]],
    [{ from_date: "2026-11-10T08:00:00.000003Z" }, ["SETTLE-HIST-3"]],
    [{ invoice_type: "retail" }, ["SETTLE-HIST-2"]],
    [{ invoice_type: "logistics", from_date: "2026-11-01" }, []],
  ])("filters by %p", async (query, expected) => {
    const res = await list(alice.stellarAddress, aliceToken, query as Record<string, string>);
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { invoice_number: string }) => r.invoice_number)).toEqual(
      expected
    );
  });

  it("returns an empty array for a wallet with no settlements", async () => {
    const res = await list(carol.stellarAddress, carolToken);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: [],
      meta: { limit: 20, hasMore: false, nextCursor: null },
    });
  });

  it("rejects another investor's wallet and unauthenticated calls", async () => {
    expect((await list(alice.stellarAddress, carolToken)).status).toBe(403);
    expect((await list(alice.stellarAddress, null)).status).toBe(401);
  });

  it("rejects bad parameters with 400", async () => {
    for (const [query, code] of [
      [{ limit: "0" }, "INVALID_LIMIT"],
      [{ cursor: "nope" }, "INVALID_CURSOR"],
      [{ from_date: "soon" }, "INVALID_DATE"],
      [{ from_date: "2026-12-01", to_date: "2026-01-01" }, "INVALID_DATE_RANGE"],
    ] as const) {
      const res = await list(alice.stellarAddress, aliceToken, query as Record<string, string>);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(code);
    }
  });

  describe("CSV export", () => {
    const exportCsv = (wallet: string, auth: string, query: Record<string, string> = {}) =>
      request(app)
        .get(`/api/v1/investors/${wallet}/settlements/export`)
        .query(query)
        .set("Authorization", `Bearer ${auth}`);

    it("returns every filtered record with all fields, matching the JSON", async () => {
      const [csv, json] = await Promise.all([
        exportCsv(alice.stellarAddress, aliceToken, { to_date: "2026-11-10" }),
        list(alice.stellarAddress, aliceToken, { to_date: "2026-11-10" }),
      ]);
      expect(csv.status).toBe(200);
      expect(csv.headers["content-type"]).toBe("text/csv; charset=utf-8");
      expect(csv.headers["content-disposition"]).toMatch(
        /^attachment; filename="settlements-GSETTLEH\.csv"$/
      );
      expect(csv.headers["cache-control"]).toBe("no-store");

      const lines = csv.text.trimEnd().split("\r\n");
      const header = lines[0].split(",");
      expect(header).toEqual(Object.keys(json.body.data[0]));
      expect(lines).toHaveLength(3);
      const rows = lines
        .slice(1)
        .map((line) => Object.fromEntries(line.split(",").map((v, i) => [header[i], v])));
      expect(rows.map((r) => r.invoice_number)).toEqual(["SETTLE-HIST-2", "SETTLE-HIST-1"]);
      expect(rows[1]).toMatchObject({
        net_return_usd: "19.5000",
        net_return_pct: "7.8000",
        fees: "5.5000",
        fee_data_available: "true",
      });
    });

    it("is only the header for a wallet with no settlements", async () => {
      const res = await exportCsv(carol.stellarAddress, carolToken);
      expect(res.status).toBe(200);
      expect(res.text.trimEnd().split("\r\n")).toHaveLength(1);
    });

    it("rejects another investor's wallet", async () => {
      expect((await exportCsv(alice.stellarAddress, carolToken)).status).toBe(403);
    });
  });
});
