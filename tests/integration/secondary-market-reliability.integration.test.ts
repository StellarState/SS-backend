import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { DataSource } from "typeorm";
import { reliabilityDatabase, closeReliabilityDatabase } from "../helpers/postgres-reliability";
import { SecondaryMarketService } from "../../src/services/secondary-market.service";
import { SecondaryDepthService } from "../../src/services/secondary-depth.service";
import { AddSecondaryDepthSnapshots1795400000000 } from "../../src/migrations/1795400000000-AddSecondaryDepthSnapshots";
import { SecondaryDepthSnapshot } from "../../src/models/SecondaryDepthSnapshot.model";
import { Invoice } from "../../src/models/Invoice.model";
import { User } from "../../src/models/User.model";
import { Investment } from "../../src/models/Investment.model";
import { SecondaryListing } from "../../src/models/SecondaryListing.model";
import {
  InvoiceStatus,
  InvestmentStatus,
  KYCStatus,
  ListingStatus,
  UserType,
} from "../../src/types/enums";
import { createSecondaryMarketRouter } from "../../src/routes/secondary-market.routes";
import { MetricsRegistry } from "../../src/observability/metrics";

const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite("secondary revisions and transactional depth (#838, #839)", () => {
  let source: DataSource;
  let invoice: Invoice;
  let seller: User;
  let buyer: User;
  let market: SecondaryMarketService;
  let depth: SecondaryDepthService;
  let metrics: MetricsRegistry;
  const migration = new AddSecondaryDepthSnapshots1795400000000();
  beforeAll(async () => {
    source = await reliabilityDatabase();
    const runner = source.createQueryRunner();
    await runner.query("DROP TABLE secondary_depth_snapshots");
    await migration.up(runner);
    await runner.release();
  }, 60000);
  afterAll(async () => {
    if (source) await closeReliabilityDatabase(source);
  });
  beforeEach(async () => {
    seller = await source.getRepository(User).save({
      stellarAddress: `G${randomUUID().replace(/-/g, "")}`,
      userType: UserType.INVESTOR,
      kycStatus: KYCStatus.APPROVED,
    });
    buyer = await source.getRepository(User).save({
      stellarAddress: `G${randomUUID().replace(/-/g, "")}`,
      userType: UserType.INVESTOR,
      kycStatus: KYCStatus.APPROVED,
    });
    invoice = await source.getRepository(Invoice).save({
      sellerId: seller.id,
      invoiceNumber: randomUUID(),
      customerName: "Customer",
      amount: "1000",
      discountRate: "0",
      netAmount: "1000",
      dueDate: new Date(Date.now() + 10 * 86400000),
      status: InvoiceStatus.FUNDED,
    });
    await source.getRepository(Investment).save({
      invoiceId: invoice.id,
      investorId: seller.id,
      investorWallet: seller.stellarAddress,
      investmentAmount: "1000",
      expectedReturn: "1000",
      status: InvestmentStatus.CONFIRMED,
    });
    market = new SecondaryMarketService(source);
    metrics = new MetricsRegistry();
    depth = new SecondaryDepthService(source, metrics);
  });
  const listing = (quantity = "20", price = "1") =>
    market.createListing({
      invoiceId: invoice.id,
      sellerId: seller.id,
      sellerWallet: seller.stellarAddress,
      quantity,
      pricePerFraction: price,
    });

  it("serializes cancel against relist, rejects the loser, and makes cancellation retry idempotent", async () => {
    const row = await listing();
    const result = await Promise.allSettled([
      market.cancelListing(row.id, seller.stellarAddress, "Changed plans", seller.id, row.version),
      market.relistListing(row.id, seller.stellarAddress, seller.id, {
        expected_version: row.version,
        quantity: "30",
        price_per_fraction: "2",
      }),
    ]);
    expect(result.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const failed = result.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ statusCode: 409, code: "LISTING_CONFLICT" });
    const current = await source.getRepository(SecondaryListing).findOneByOrFail({ id: row.id });
    expect(current.version).toBe(row.version + 1);
    if (current.status === ListingStatus.CANCELLED) {
      expect(
        await market.cancelListing(
          row.id,
          seller.stellarAddress,
          "Changed plans",
          seller.id,
          row.version
        )
      ).toMatchObject({ version: current.version });
    } else {
      expect(current.quantity).toBe("30.0000");
      await expect(
        market.cancelListing(row.id, seller.stellarAddress, "Changed plans", seller.id, row.version)
      ).rejects.toMatchObject({ code: "LISTING_CONFLICT" });
    }
  });

  it("returns structured stale cancellation conflicts and requires a version on both aliases", async () => {
    const row = await listing();
    await market.relistListing(row.id, seller.stellarAddress, seller.id, {
      expected_version: row.version,
      quantity: "30",
      price_per_fraction: "2",
    });
    const app = express();
    app.use(express.json());
    app.use(
      "/secondary",
      createSecondaryMarketRouter({
        secondaryMarketService: market,
        authService: { getCurrentUser: async () => seller } as never,
      })
    );
    const res = await request(app)
      .post(`/secondary/listings/${row.id}/cancel`)
      .set("Authorization", "Bearer test")
      .send({ expected_version: row.version })
      .expect(409);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: "LISTING_CONFLICT",
        details: {
          listing_id: row.id,
          expected_version: row.version,
          current_version: row.version + 1,
          quantity: "30.0000",
        },
      },
    });
    await request(app)
      .delete(`/secondary/listings/${row.id}`)
      .set("Authorization", "Bearer test")
      .expect(428);
  });

  it("rejects cancellation after a partial purchase even with the latest revision", async () => {
    const row = await listing();
    await market.buyListing({
      listingId: row.id,
      buyerId: buyer.id,
      buyerWallet: buyer.stellarAddress,
      quantity: "5",
    });
    const current = await source.getRepository(SecondaryListing).findOneByOrFail({ id: row.id });
    await expect(
      market.cancelListing(row.id, seller.stellarAddress, undefined, seller.id, current.version)
    ).rejects.toMatchObject({ code: "LISTING_CONFLICT" });
    await expect(
      market.cancelListing(row.id, buyer.stellarAddress, undefined, buyer.id, current.version)
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await depth.current(invoice.id)).levels).toEqual([
      { price: "1.0000", quantity: "15.0000", listing_count: 1 },
    ]);
  });

  it("rolls back both listings and snapshots and empties depth immediately after terminal changes", async () => {
    const row = await listing();
    const before = await source
      .getRepository(SecondaryDepthSnapshot)
      .countBy({ invoiceId: invoice.id });
    await expect(
      source.transaction(async (manager) => {
        await manager.update(SecondaryListing, row.id, { quantity: "99" });
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");
    expect(
      await source.getRepository(SecondaryDepthSnapshot).countBy({ invoiceId: invoice.id })
    ).toBe(before);
    expect((await depth.current(invoice.id)).levels[0].quantity).toBe("20.0000");
    await source.getRepository(Invoice).update(invoice.id, { status: InvoiceStatus.SETTLED });
    expect((await depth.current(invoice.id)).levels).toEqual([]);
  });

  it("refreshes an expired snapshot before serving it and exposes observed lag", async () => {
    const row = await listing();
    await source
      .getRepository(SecondaryListing)
      .update(row.id, { expiresAt: new Date(Date.now() + 100) });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await depth.current(invoice.id)).levels).toEqual([]);
    expect(metrics.renderPrometheusMetrics()).toMatch(
      /stellarsettle_secondary_depth_snapshot_lag_seconds 0\.[0-9]+/
    );
  });

  it("cursor pages stay stable when new snapshots arrive and reject cross invoice cursors", async () => {
    const row = await listing();
    for (let i = 0; i < 5; i++)
      await source.getRepository(SecondaryListing).update(row.id, { quantity: String(20 + i) });
    const first = await depth.history(invoice.id, 2);
    await source.getRepository(SecondaryListing).update(row.id, { quantity: "50" });
    const second = await depth.history(invoice.id, 2, first.meta.next_cursor);
    expect(second.data.every((snapshot) => BigInt(snapshot.id) < BigInt(first.data[1].id))).toBe(
      true
    );
    expect(new Set([...first.data, ...second.data].map((snapshot) => snapshot.id)).size).toBe(4);
    await expect(depth.history(invoice.id, 0)).rejects.toMatchObject({ statusCode: 400 });
    const overflow = Buffer.from(
      JSON.stringify({
        invoice: invoice.id,
        before: "9999999999999999999",
        watermark: "9999999999999999999",
      })
    ).toString("base64url");
    await expect(depth.history(invoice.id, 2, overflow)).rejects.toMatchObject({
      code: "INVALID_DEPTH_CURSOR",
    });
    await expect(depth.history(invoice.id, 2, "broken")).rejects.toMatchObject({
      code: "INVALID_DEPTH_CURSOR",
    });
  });

  it("keeps exact depth through a concurrent burst and terminal cancellation", async () => {
    // 40 independent transactions contend on the same order book.
    const rows = await Promise.all(
      Array.from({ length: 40 }, (_, i) => listing("1", i % 2 ? "2" : "1"))
    );
    expect((await depth.current(invoice.id)).levels).toEqual([
      { price: "1.0000", quantity: "20.0000", listing_count: 20 },
      { price: "2.0000", quantity: "20.0000", listing_count: 20 },
    ]);
    await Promise.all(
      rows.map((row) =>
        market.cancelListing(row.id, seller.stellarAddress, undefined, seller.id, row.version)
      )
    );
    expect((await depth.current(invoice.id)).levels).toEqual([]);
    expect(
      await source.getRepository(SecondaryDepthSnapshot).countBy({ invoiceId: invoice.id })
    ).toBe(80);
  }, 60000);

  it("supports snapshot migration rollback and reapplication", async () => {
    const runner = source.createQueryRunner();
    await migration.down(runner);
    await migration.up(runner);
    await runner.release();
    expect((await depth.current(invoice.id)).levels).toEqual([]);
  });
});
