import "reflect-metadata";
import request from "supertest";
import { Keypair } from "stellar-sdk";
import express from "express";
import { DataSource, getMetadataArgsStorage } from "typeorm";

import { createApp } from "../../src/app";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import {
  cursorPagination,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../../src/middleware/cursor-pagination.middleware";
import { AuthChallenge } from "../../src/models/AuthChallenge.model";
import { Investment } from "../../src/models/Investment.model";
import { InvestorReturn } from "../../src/models/InvestorReturn.model";
import { Invoice } from "../../src/models/Invoice.model";
import { KYCVerification } from "../../src/models/KYCVerification.model";
import { KycHistory } from "../../src/models/KycHistory.model";
import { Notification } from "../../src/models/Notification.model";
import { SecondaryListing } from "../../src/models/SecondaryListing.model";
import { Transaction } from "../../src/models/Transaction.model";
import { User } from "../../src/models/User.model";
import { Watchlist } from "../../src/models/Watchlist.model";
import { createAuthService } from "../../src/services/auth.service";
import { PortfolioService } from "../../src/services/portfolio.service";
import { SecondaryMarketService } from "../../src/services/secondary-market.service";
import { WatchlistService } from "../../src/services/watchlist.service";
import {
  InvestmentStatus,
  InvoiceStatus,
  KYCStatus,
  ListingStatus,
  UserType,
} from "../../src/types/enums";
import type { AppConfig } from "../../src/config/env";
import { logger } from "../../src/observability/logger";

/**
 * Issue #559: the shared cursor pagination middleware on the watchlist,
 * secondary listings, portfolio and payout history endpoints (invoices are
 * covered in tests/unit/invoice-cursor-pagination.test.ts).
 */

const JWT_SECRET = "test-jwt-secret-key-for-cursor-pagination";
const ROWS = 7;

function patchEntityMetadataForSQLite(): void {
  for (const column of getMetadataArgsStorage().columns) {
    if (column.options.type === "timestamptz") column.options.type = "datetime" as never;
    if (column.options.type === "jsonb") column.options.type = "simple-json" as never;
    if (column.options.type === "enum") column.options.type = "varchar" as never;
  }
}

describe("Integration: cursor pagination (issue #559)", () => {
  let dataSource: DataSource;
  let app: ReturnType<typeof createApp>;
  let investor: User;
  let token: string;

  // Several rows share a timestamp so pages must break ties on id.
  const at = (i: number) => new Date(Date.UTC(2026, 8, 1, 12, 0, Math.floor(i / 3)));

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    patchEntityMetadataForSQLite();

    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      dropSchema: true,
      synchronize: true,
      entities: [
        User,
        Invoice,
        Investment,
        InvestorReturn,
        AuthChallenge,
        Transaction,
        KYCVerification,
        KycHistory,
        Notification,
        SecondaryListing,
        Watchlist,
      ],
    });
    await dataSource.initialize();

    const config = {
      jwt: { secret: JWT_SECRET, expiresIn: "1h" },
      auth: { challengeTtlMs: 300_000 },
      stellar: { network: "testnet", networkPassphrase: "Test SDF Network ; September 2015" },
    } as unknown as AppConfig;

    const authService = createAuthService(dataSource, config);
    app = createApp({
      authService,
      watchlistService: new WatchlistService(dataSource),
      secondaryMarketService: new SecondaryMarketService(dataSource),
      portfolioService: new PortfolioService(dataSource),
      metricsEnabled: false,
      http: { rateLimit: { enabled: false } },
    });

    const users = dataSource.getRepository(User);
    investor = await users.save(
      users.create({
        stellarAddress: Keypair.random().publicKey(),
        userType: UserType.INVESTOR,
        kycStatus: KYCStatus.APPROVED,
      })
    );
    const seller = await users.save(
      users.create({
        stellarAddress: Keypair.random().publicKey(),
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
      })
    );
    token = authService.generateToken(investor).token;

    const invoices = dataSource.getRepository(Invoice);
    const investments = dataSource.getRepository(Investment);
    const returns = dataSource.getRepository(InvestorReturn);
    const watchlist = dataSource.getRepository(Watchlist);
    const listings = dataSource.getRepository(SecondaryListing);

    for (let i = 0; i < ROWS; i++) {
      const invoice = await invoices.save(
        invoices.create({
          sellerId: seller.id,
          invoiceNumber: `INV-${i}`,
          customerName: "Acme Ltd",
          amount: "1000.0000",
          discountRate: "5.00",
          netAmount: "950.0000",
          dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          status: InvoiceStatus.FUNDED,
        })
      );
      const investment = await investments.save(
        investments.create({
          invoiceId: invoice.id,
          investorId: investor.id,
          investmentAmount: "100.0000",
          expectedReturn: "105.0000",
          status: InvestmentStatus.CONFIRMED,
          createdAt: at(i),
        })
      );
      await returns.save(
        returns.create({
          invoiceId: invoice.id,
          investmentId: investment.id,
          investorId: investor.id,
          amount: "105.0000",
          returnAmount: "5.0000",
          createdAt: at(i),
        })
      );
      await watchlist.save(
        watchlist.create({
          walletAddress: investor.stellarAddress,
          userId: investor.id,
          invoiceId: invoice.id,
          createdAt: at(i),
        })
      );
      await listings.save(
        listings.create({
          invoiceId: invoice.id,
          sellerWallet: seller.stellarAddress,
          sellerId: seller.id,
          quantity: "10.0000",
          // Duplicate prices exercise the tiebreak on price sort too.
          pricePerFraction: `${1 + (i % 3)}.0000`,
          totalPrice: "10.0000",
          status: ListingStatus.ACTIVE,
          expiresAt: new Date(Date.now() + (i + 1) * 60 * 60 * 1000),
          createdAt: at(i),
        })
      );
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  const get = (path: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);

  /** Follows next_cursor to the end, returning every page's ids. */
  async function walk(path: string, idOf: (row: Record<string, unknown>) => string, extract = "data") {
    const pages: string[][] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const sep = path.includes("?") ? "&" : "?";
      const response = await get(cursor ? `${path}${sep}cursor=${cursor}` : path);
      expect(response.status).toBe(200);
      const rows = (extract === "data"
        ? response.body.data
        : response.body.data[extract]) as Record<string, unknown>[];
      pages.push(rows.map(idOf));
      cursor = response.body.pagination.next_cursor;
      if (!cursor) {
        expect(response.body.pagination).not.toHaveProperty("next_cursor");
        expect(response.body.pagination.has_more).toBe(false);
        break;
      }
      expect(response.body.pagination.has_more).toBe(true);
    }
    return pages;
  }

  // Every row has all four values: with fewer, it.each would pass Jest's
  // `done` callback as the last argument.
  const endpoints: Array<[string, string, (row: Record<string, unknown>) => string, string]> = [
    ["watchlist", "/api/v1/watchlist?limit=3", (row) => String(row.id), "data"],
    ["secondary listings", "/api/v1/secondary/listings?limit=3", (row) => String(row.id), "data"],
    [
      "secondary listings by price",
      "/api/v1/secondary/listings?limit=2&sort=price&order=asc",
      (row) => String(row.id),
      "data",
    ],
    ["portfolio", "/portfolio?limit=3", (row) => String(row.investmentId), "positions"],
    ["payout history", "/portfolio/payouts?limit=3", (row) => String(row.id), "data"],
  ];

  it.each(endpoints)(
    "%s: pages cover every row exactly once and next_cursor disappears on the last page",
    async (_name, path, idOf, extract) => {
      const pages = await walk(path, idOf, extract);
      const ids = pages.flat();

      expect(ids).toHaveLength(ROWS);
      expect(new Set(ids).size).toBe(ROWS);
      const limit = Number(new URL(path, "http://x").searchParams.get("limit"));
      expect(pages.slice(0, -1).every((page) => page.length === limit)).toBe(true);
    }
  );

  it("returns pages in sort order", async () => {
    const response = await get("/api/v1/secondary/listings?limit=100&sort=price&order=asc");
    const prices = response.body.data.map((row: { pricePerFraction: string }) =>
      Number(row.pricePerFraction)
    );
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it("does not expose raw ids in the cursor", async () => {
    const response = await get("/portfolio/payouts?limit=1");
    const cursor: string = response.body.pagination.next_cursor;
    const lastId: string = response.body.data[0].id;

    expect(cursor).toBeDefined();
    for (const encoding of ["base64", "base64url", "utf8"] as const) {
      expect(Buffer.from(cursor, encoding === "utf8" ? "utf8" : encoding).toString("utf8")).not.toContain(
        lastId
      );
    }
  });

  it("rejects malformed, tampered and cross-endpoint cursors with 400", async () => {
    const first = await get("/api/v1/watchlist?limit=2");
    const cursor: string = first.body.pagination.next_cursor;

    const tampered = Buffer.from(cursor, "base64url");
    tampered[tampered.length - 1] ^= 0x01;

    for (const bad of ["garbage", "", tampered.toString("base64url")]) {
      if (!bad) continue;
      const response = await get(`/api/v1/watchlist?cursor=${encodeURIComponent(bad)}`);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("INVALID_CURSOR");
    }

    // A watchlist cursor is not valid on another endpoint.
    const crossed = await get(`/portfolio/payouts?cursor=${cursor}`);
    expect(crossed.status).toBe(400);
    expect(crossed.body.error.code).toBe("INVALID_CURSOR");

    // Nor for a different sort on the same endpoint.
    const listingCursor = (await get("/api/v1/secondary/listings?limit=2")).body.pagination
      .next_cursor;
    const resorted = await get(`/api/v1/secondary/listings?sort=price&cursor=${listingCursor}`);
    expect(resorted.status).toBe(400);
  });

  it("defaults the page size to 25 and caps it at 100", async () => {
    const defaults = await get("/api/v1/watchlist");
    expect(defaults.body.pagination.limit).toBe(DEFAULT_PAGE_SIZE);

    const capped = await get("/api/v1/watchlist?limit=1000");
    expect(capped.status).toBe(200);
    expect(capped.body.pagination.limit).toBe(MAX_PAGE_SIZE);

    const invalid = await get("/api/v1/watchlist?limit=-1");
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("INVALID_PAGE_SIZE");
  });

  it("rejects unknown sort keys", async () => {
    const response = await get("/api/v1/secondary/listings?sort=seller_wallet");
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_SORT");
  });

  it("puts the parsed parameters on req.pagination for any route", async () => {
    const probe = express();
    probe.get("/items", cursorPagination({ scope: "probe" }), (req, res) => {
      res.json(req.pagination);
    });
    probe.use(createErrorMiddleware(logger));

    const response = await request(probe).get("/items?limit=10&order=asc");
    expect(response.body).toEqual({
      scope: "probe",
      limit: 10,
      sort: "created_at",
      order: "ASC",
      after: null,
    });
  });

  it("does not skip rows inserted while a client is paging", async () => {
    const first = await get("/api/v1/watchlist?limit=3");
    const seen = first.body.data.map((row: { id: string }) => row.id);

    // A newer entry appears between page requests.
    const invoices = dataSource.getRepository(Invoice);
    const template = await invoices.findOneByOrFail({ invoiceNumber: "INV-0" });
    const invoice = await invoices.save(
      invoices.create({ ...template, id: undefined, invoiceNumber: "INV-NEW", version: undefined })
    );
    const watchlist = dataSource.getRepository(Watchlist);
    const fresh = await watchlist.save(
      watchlist.create({
        walletAddress: investor.stellarAddress,
        userId: investor.id,
        invoiceId: invoice.id,
        createdAt: new Date(Date.UTC(2026, 8, 2)),
      })
    );

    let cursor: string | undefined = first.body.pagination.next_cursor;
    while (cursor) {
      const page = await get(`/api/v1/watchlist?limit=3&cursor=${cursor}`);
      seen.push(...page.body.data.map((row: { id: string }) => row.id));
      cursor = page.body.pagination.next_cursor;
    }

    // The original rows are all there exactly once; the new one sorts before
    // the cursor, so it shows up on the next fresh read instead of shifting pages.
    expect(seen).toHaveLength(ROWS);
    expect(new Set(seen).size).toBe(ROWS);
    expect(seen).not.toContain(fresh.id);

    await watchlist.delete({ id: fresh.id });
  });

  it("scopes every list to the requesting wallet", async () => {
    const users = dataSource.getRepository(User);
    const stranger = await users.save(
      users.create({
        stellarAddress: Keypair.random().publicKey(),
        userType: UserType.INVESTOR,
        kycStatus: KYCStatus.APPROVED,
      })
    );
    const strangerToken = createAuthService(dataSource, {
      jwt: { secret: JWT_SECRET, expiresIn: "1h" },
    } as unknown as AppConfig).generateToken(stranger).token;

    for (const path of ["/api/v1/watchlist", "/portfolio/payouts"]) {
      const response = await request(app)
        .get(path)
        .set("Authorization", `Bearer ${strangerToken}`);
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(0);
    }
  });
});
