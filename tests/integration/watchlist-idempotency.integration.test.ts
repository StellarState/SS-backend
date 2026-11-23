import { randomUUID } from "node:crypto";
import express, { NextFunction, Response } from "express";
import request from "supertest";
import { DataSource } from "typeorm";
import { createTestDataSource } from "../helpers/test-data-source";
import { reliabilityDatabase, closeReliabilityDatabase } from "../helpers/postgres-reliability";
import { WatchlistService } from "../../src/services/watchlist.service";
import { WatchlistController } from "../../src/controllers/watchlist.controller";
import { Watchlist } from "../../src/models/Watchlist.model";
import { Invoice } from "../../src/models/Invoice.model";
import { User } from "../../src/models/User.model";
import { InvoiceStatus, KYCStatus, UserType } from "../../src/types/enums";
import type { AuthenticatedRequest } from "../../src/types/auth";

/**
 * Issue #810: watchlist add/remove must be idempotent under retries.
 *
 * Runs against a real database: SQLite in-memory always, and PostgreSQL in an
 * isolated schema when DATABASE_URL is set (as it is in CI). The Postgres run
 * is the one that exercises genuinely concurrent transactions contending on
 * the uq_watchlist_wallet_invoice unique index.
 */
interface Backend {
  name: string;
  /** Supports concurrent transactions and native jsonb. */
  realConcurrency: boolean;
  open: () => Promise<DataSource>;
  close: (source: DataSource) => Promise<void>;
}

const backends: Backend[] = [
  {
    name: "sqlite",
    realConcurrency: false,
    open: async () => {
      const source = await createTestDataSource();
      await source.synchronize(true);
      return source;
    },
    close: (source) => source.destroy(),
  },
];

if (process.env.DATABASE_URL) {
  backends.push({
    name: "postgres",
    realConcurrency: true,
    open: reliabilityDatabase,
    close: closeReliabilityDatabase,
  });
}

const CONCURRENCY = 10;

describe.each(backends)(
  "watchlist idempotency on $name (#810)",
  ({ open, close, realConcurrency }) => {
    // SQLite in-memory is a single connection that cannot open overlapping
    // transactions, and the test helper maps jsonb to text, so race and notes
    // assertions only run against Postgres.
    const pgIt = realConcurrency ? it : it.skip;
    const pgDescribe = realConcurrency ? describe : describe.skip;
    let source: DataSource;
    let service: WatchlistService;
    let investor: User;
    let invoice: Invoice;

    beforeAll(async () => {
      source = await open();
      service = new WatchlistService(source);
    }, 60000);

    afterAll(async () => {
      if (source?.isInitialized) await close(source);
    });

    beforeEach(async () => {
      investor = await source.getRepository(User).save(
        source.getRepository(User).create({
          stellarAddress: `G${randomUUID().replace(/-/g, "").toUpperCase()}`,
          userType: UserType.INVESTOR,
          kycStatus: KYCStatus.APPROVED,
        })
      );
      invoice = await source.getRepository(Invoice).save(
        source.getRepository(Invoice).create({
          sellerId: investor.id,
          invoiceNumber: `INV-${randomUUID()}`,
          customerName: "Watchlist Customer",
          amount: "1000.0000",
          discountRate: "5.00",
          netAmount: "950.0000",
          dueDate: new Date(Date.now() + 30 * 86400000),
          status: InvoiceStatus.PUBLISHED,
        })
      );
    });

    const rowsFor = (wallet: string, invoiceId: string) =>
      source
        .getRepository(Watchlist)
        .find({ where: { walletAddress: wallet, invoiceId }, withDeleted: true });

    describe("add", () => {
      it("creates no duplicate when repeated", async () => {
        const first = await service.addToWatchlist(
          investor.stellarAddress,
          invoice.id,
          investor.id
        );
        const second = await service.addToWatchlist(
          investor.stellarAddress,
          invoice.id,
          investor.id
        );
        const third = await service.addToWatchlist(
          investor.stellarAddress,
          invoice.id,
          investor.id
        );

        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(third.created).toBe(false);
        expect(second.entry.id).toBe(first.entry.id);
        expect(third.entry.id).toBe(first.entry.id);
        expect(await rowsFor(investor.stellarAddress, invoice.id)).toHaveLength(1);
      });

      pgIt("keeps the original notes when a retry carries different notes", async () => {
        await service.addToWatchlist(investor.stellarAddress, invoice.id, investor.id, {
          tag: "a",
        });
        const retry = await service.addToWatchlist(
          investor.stellarAddress,
          invoice.id,
          investor.id,
          {
            tag: "b",
          }
        );

        expect(retry.created).toBe(false);
        const [row] = await rowsFor(investor.stellarAddress, invoice.id);
        expect(row.notes).toEqual({ tag: "a" });
      });

      it("normalizes wallet and invoice identifiers to a single entry", async () => {
        const first = await service.addToWatchlist(investor.stellarAddress, invoice.id);
        const variant = await service.addToWatchlist(
          `  ${investor.stellarAddress.toLowerCase()} `,
          ` ${invoice.id.toUpperCase()}  `
        );

        expect(variant.created).toBe(false);
        expect(variant.entry.id).toBe(first.entry.id);
        expect(variant.entry.walletAddress).toBe(investor.stellarAddress);
        expect(variant.entry.invoiceId).toBe(invoice.id);
        expect(await rowsFor(investor.stellarAddress, invoice.id)).toHaveLength(1);
      });

      it("rejects a malformed invoice id with 400", async () => {
        await expect(
          service.addToWatchlist(investor.stellarAddress, "not-a-uuid")
        ).rejects.toMatchObject({ code: "INVALID_INVOICE_ID", statusCode: 400 });
      });

      it("rejects an unknown invoice with 404", async () => {
        await expect(
          service.addToWatchlist(investor.stellarAddress, randomUUID())
        ).rejects.toMatchObject({ code: "INVOICE_NOT_FOUND", statusCode: 404 });
      });

      it("restores a soft-deleted entry instead of failing on the unique index", async () => {
        const first = await service.addToWatchlist(investor.stellarAddress, invoice.id);
        await source.getRepository(Watchlist).softDelete({ id: first.entry.id });

        const readd = await service.addToWatchlist(investor.stellarAddress, invoice.id);

        expect(readd.created).toBe(true);
        expect(readd.entry.id).toBe(first.entry.id);
        expect(await service.isInWatchlist(investor.stellarAddress, invoice.id)).toBe(true);
        const page = await service.getWatchlist(investor.stellarAddress);
        expect(page.meta.total).toBe(1);
      });
    });

    describe("remove", () => {
      it("succeeds when repeated and leaves the entry absent", async () => {
        await service.addToWatchlist(investor.stellarAddress, invoice.id);

        const first = await service.removeFromWatchlist(investor.stellarAddress, invoice.id);
        const second = await service.removeFromWatchlist(investor.stellarAddress, invoice.id);

        expect(first.removed).toBe(true);
        expect(second.removed).toBe(false);
        expect(await rowsFor(investor.stellarAddress, invoice.id)).toHaveLength(0);
        expect(await service.isInWatchlist(investor.stellarAddress, invoice.id)).toBe(false);
      });

      it("succeeds for an entry that never existed", async () => {
        await expect(
          service.removeFromWatchlist(investor.stellarAddress, randomUUID())
        ).resolves.toEqual({ removed: false });
      });

      it("matches normalized identifiers", async () => {
        await service.addToWatchlist(investor.stellarAddress, invoice.id);
        const result = await service.removeFromWatchlist(
          investor.stellarAddress.toLowerCase(),
          invoice.id.toUpperCase()
        );

        expect(result.removed).toBe(true);
        expect(await rowsFor(investor.stellarAddress, invoice.id)).toHaveLength(0);
      });
    });

    pgDescribe("database races", () => {
      it("concurrent adds produce exactly one row and one creator", async () => {
        const results = await Promise.all(
          Array.from({ length: CONCURRENCY }, () =>
            service.addToWatchlist(investor.stellarAddress, invoice.id, investor.id)
          )
        );

        expect(results.filter((r) => r.created)).toHaveLength(1);
        expect(new Set(results.map((r) => r.entry.id)).size).toBe(1);
        expect(await rowsFor(investor.stellarAddress, invoice.id)).toHaveLength(1);
      });

      it("concurrent removes all succeed and exactly one deletes the row", async () => {
        await service.addToWatchlist(investor.stellarAddress, invoice.id);

        const results = await Promise.all(
          Array.from({ length: CONCURRENCY }, () =>
            service.removeFromWatchlist(investor.stellarAddress, invoice.id)
          )
        );

        expect(results.filter((r) => r.removed)).toHaveLength(1);
        expect(await rowsFor(investor.stellarAddress, invoice.id)).toHaveLength(0);
      });

      it("interleaved adds and removes end in a consistent state with no unexpected errors", async () => {
        const outcomes = await Promise.allSettled(
          Array.from({ length: CONCURRENCY }, (_, i) =>
            i % 2 === 0
              ? service.addToWatchlist(investor.stellarAddress, invoice.id)
              : service.removeFromWatchlist(investor.stellarAddress, invoice.id)
          )
        );

        // The only permitted failure is the documented, retryable conflict.
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") {
            expect(outcome.reason).toMatchObject({
              code: "WATCHLIST_CONCURRENT_MODIFICATION",
              statusCode: 409,
            });
          }
        }

        // Final state is either present (one row) or absent (zero rows), never
        // duplicated, and isInWatchlist agrees with the table.
        const rows = await rowsFor(investor.stellarAddress, invoice.id);
        expect(rows.length).toBeLessThanOrEqual(1);
        expect(await service.isInWatchlist(investor.stellarAddress, invoice.id)).toBe(
          rows.length === 1
        );

        // Settling with one more add converges on "present".
        const settled = await service.addToWatchlist(investor.stellarAddress, invoice.id);
        expect(settled.entry.invoiceId).toBe(invoice.id);
        expect(await rowsFor(investor.stellarAddress, invoice.id)).toHaveLength(1);
      });
    });

    describe("HTTP contract", () => {
      const buildApp = () => {
        const app = express();
        app.use(express.json());
        app.use((req, _res: Response, next: NextFunction) => {
          (req as AuthenticatedRequest).user = {
            id: investor.id,
            stellarAddress: investor.stellarAddress,
          } as AuthenticatedRequest["user"];
          next();
        });
        const controller = new WatchlistController(service);
        app.post("/watchlist/:invoiceId", controller.addToWatchlist);
        app.delete("/watchlist/:invoiceId", controller.removeFromWatchlist);
        return app;
      };

      it("returns 201 then 200 with the same entry on a repeated add", async () => {
        const app = buildApp();

        const first = await request(app).post(`/watchlist/${invoice.id}`).send({});
        const second = await request(app).post(`/watchlist/${invoice.id}`).send({});

        expect(first.status).toBe(201);
        expect(first.body.meta).toEqual({ created: true });
        expect(second.status).toBe(200);
        expect(second.body.meta).toEqual({ created: false });
        expect(second.body.data.id).toBe(first.body.data.id);
      });

      it("returns 204 on every repeated remove", async () => {
        const app = buildApp();
        await request(app).post(`/watchlist/${invoice.id}`).send({});

        const first = await request(app).delete(`/watchlist/${invoice.id}`);
        const second = await request(app).delete(`/watchlist/${invoice.id}`);

        expect(first.status).toBe(204);
        expect(second.status).toBe(204);
      });

      it("returns 400 for a malformed invoice id", async () => {
        const res = await request(buildApp()).delete("/watchlist/not-a-uuid");
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("INVALID_INVOICE_ID");
      });
    });
  }
);
