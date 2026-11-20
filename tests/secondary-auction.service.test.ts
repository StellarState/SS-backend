import { DataSource } from "typeorm";
import { SecondaryAuctionService } from "../src/services/secondary-auction.service";
import { SecondaryAuction } from "../src/models/SecondaryAuction.model";
import { SecondaryBid } from "../src/models/SecondaryBid.model";
import { Investment } from "../src/models/Investment.model";
import { Invoice } from "../src/models/Invoice.model";
import { User } from "../src/models/User.model";
import { AuctionStatus, InvestmentStatus, InvoiceStatus } from "../src/types/enums";

function createFakeDataSource(
  auctions: SecondaryAuction[] = [],
  bids: SecondaryBid[] = [],
  investments: Investment[] = [],
  invoices: Invoice[] = [],
  users: User[] = [],
) {
  const auctionRows = [...auctions];
  const bidRows = [...bids];
  const investmentRows = [...investments];
  const invoiceRows = [...invoices];
  const userRows = [...users];

  const getRepository = (entity: unknown) => {
    if (entity === SecondaryAuction) {
      return {
        findOneBy: async (where: { auctionId: string }) =>
          auctionRows.find((a) => a.auctionId === where.auctionId) ?? null,
        findOne: async (options: { where: { auctionId: string }; lock?: unknown }) =>
          auctionRows.find((a) => a.auctionId === options.where.auctionId) ?? null,
        find: async (options: { where: { invoiceId: string | null } }) =>
          auctionRows.filter((a) => a.invoiceId === options.where.invoiceId),
        create: (data: Partial<SecondaryAuction>) => ({ ...data }) as SecondaryAuction,
        save: async (row: SecondaryAuction) => {
          const idx = auctionRows.findIndex((a) => a.auctionId === row.auctionId);
          const full = {
            ...row,
            id: row.id ?? `auc-${auctionRows.length + 1}`,
            bidCount: row.bidCount ?? 0,
            highestBid: row.highestBid ?? "0.0000",
            highestBidder: row.highestBidder ?? null,
            createdAt: row.createdAt ?? new Date(),
            updatedAt: row.updatedAt ?? new Date(),
          } as SecondaryAuction;
          if (idx >= 0) auctionRows[idx] = full;
          else auctionRows.push(full);
          return full;
        },
      };
    }
    if (entity === SecondaryBid) {
      return {
        create: (data: Partial<SecondaryBid>) => ({ ...data }) as SecondaryBid,
        save: async (row: SecondaryBid) => {
          const full = {
            ...row,
            id: row.id ?? `bid-${bidRows.length + 1}`,
            createdAt: row.createdAt ?? new Date(),
          } as SecondaryBid;
          bidRows.push(full);
          return full;
        },
        find: async (options: {
          where: { auctionId: string };
          order?: Record<string, string>;
          lock?: unknown;
        }) => {
          const matched = bidRows.filter((b) => b.auctionId === options.where.auctionId);
          if (options.order?.amount === "DESC") {
            matched.sort((a, b) => Number(b.amount) - Number(a.amount));
          }
          return matched;
        },
        findAndCount: async (options: {
          where: { auctionId: string };
          order: Record<string, string>;
          skip: number;
          take: number;
        }) => {
          const matched = bidRows
            .filter((b) => b.auctionId === options.where.auctionId)
            .sort((a, b) => {
              const aT = a.placedAt?.getTime() ?? 0;
              const bT = b.placedAt?.getTime() ?? 0;
              return options.order.placedAt === "DESC" ? bT - aT : aT - bT;
            });
          return [matched.slice(options.skip, options.skip + options.take), matched.length];
        },
      };
    }
    if (entity === Investment) {
      return {
        create: (data: Partial<Investment>) => ({ ...data }) as Investment,
        save: async (row: Investment) => {
          const idx = investmentRows.findIndex((i) => i.id === row.id);
          const full = {
            ...row,
            id: row.id ?? `inv-${investmentRows.length + 1}`,
            createdAt: row.createdAt ?? new Date(),
            updatedAt: row.updatedAt ?? new Date(),
          } as Investment;
          if (idx >= 0) investmentRows[idx] = full;
          else investmentRows.push(full);
          return full;
        },
        findOne: async (options: {
          where: Array<{ invoiceId?: string; investorWallet?: string; status?: InvestmentStatus }>;
          lock?: unknown;
        }) => {
          const criteria = Array.isArray(options.where) ? options.where : [options.where];
          return (
            investmentRows.find((i) =>
              criteria.some(
                (c) =>
                  (!c.invoiceId || i.invoiceId === c.invoiceId) &&
                  (!c.investorWallet || i.investorWallet === c.investorWallet) &&
                  (!c.status || i.status === c.status),
              ),
            ) ?? null
          );
        },
        findOneBy: async (where: { invoiceId?: string; investorWallet?: string; status?: InvestmentStatus }) =>
          investmentRows.find(
            (i) =>
              (!where.invoiceId || i.invoiceId === where.invoiceId) &&
              (!where.investorWallet || i.investorWallet === where.investorWallet) &&
              (!where.status || i.status === where.status),
          ) ?? null,
        find: async (options: {
          where: Array<{ invoiceId?: string; investorWallet?: string; status?: InvestmentStatus }>;
          lock?: unknown;
        }) => {
          const criteria = Array.isArray(options.where) ? options.where : [options.where];
          return investmentRows.filter((i) =>
            criteria.some(
              (c) =>
                (!c.invoiceId || i.invoiceId === c.invoiceId) &&
                (!c.investorWallet || i.investorWallet === c.investorWallet) &&
                (!c.status || i.status === c.status),
            ),
          );
        },
      };
    }
    if (entity === Invoice) {
      return {
        findOne: async (options: { where: { id: string }; lock?: unknown }) =>
          invoiceRows.find((inv) => inv.id === options.where.id) ?? null,
        findOneBy: async (where: { id: string }) =>
          invoiceRows.find((inv) => inv.id === where.id) ?? null,
      };
    }
    if (entity === User) {
      return {
        findOne: async (options: { where: { stellarAddress: string } }) =>
          userRows.find((u) => u.stellarAddress === options.where.stellarAddress) ?? null,
        findOneBy: async (where: { stellarAddress: string }) =>
          userRows.find((u) => u.stellarAddress === where.stellarAddress) ?? null,
      };
    }
    throw new Error(`Unexpected entity in test fake: ${String(entity)}`);
  };

  const fakeManager = {
    getRepository,
  };

  return {
    getRepository,
    manager: fakeManager,
    transaction: async (cb: (m: typeof fakeManager) => Promise<unknown>) => cb(fakeManager),
    // State inspection helpers for tests
    _state: { auctionRows, bidRows, investmentRows, invoiceRows, userRows },
  } as unknown as DataSource & {
    _state: {
      auctionRows: SecondaryAuction[];
      bidRows: SecondaryBid[];
      investmentRows: Investment[];
      invoiceRows: Invoice[];
      userRows: User[];
    };
  };
}

const NOW = new Date("2026-03-01T12:00:00Z");

describe("SecondaryAuctionService", () => {
  it("indexes all three events and returns accurate status and highest bid", async () => {
    const service = new SecondaryAuctionService(createFakeDataSource(), () => NOW);

    await service.ingestAuctionCreated({
      auctionId: "auc-1",
      seller: "GSELLER",
      invoiceId: "inv-1",
      reservePrice: "100.0000",
      startsAt: NOW,
      endsAt: new Date("2026-03-02T12:00:00Z"),
      eventId: "evt-create",
    });
    await service.ingestBidPlaced({
      auctionId: "auc-1",
      bidder: "GBIDDER1",
      amount: "150.0000",
      eventId: "evt-bid-1",
      occurredAt: NOW,
    });
    await service.ingestBidPlaced({
      auctionId: "auc-1",
      bidder: "GBIDDER2",
      amount: "120.0000",
      eventId: "evt-bid-2",
      occurredAt: NOW,
    });

    const auction = await service.getAuction("auc-1");

    expect(auction.status).toBe(AuctionStatus.ACTIVE);
    expect(auction.seller).toBe("GSELLER");
    expect(auction.highestBid).toBe("150.0000");
    expect(auction.highestBidder).toBe("GBIDDER1");
    expect(auction.bidCount).toBe(2);
    expect(auction.reserveMet).toBe(true);
    expect(auction.countdownSeconds).toBe(86_400);
  });

  it("returns paginated bids in descending order", async () => {
    const service = new SecondaryAuctionService(createFakeDataSource(), () => NOW);

    await service.ingestAuctionCreated({
      auctionId: "auc-2",
      seller: "GSELLER",
      reservePrice: "50.0000",
    });
    for (let i = 1; i <= 5; i++) {
      await service.ingestBidPlaced({
        auctionId: "auc-2",
        bidder: `GBIDDER${i}`,
        amount: `${100 + i}.0000`,
        eventId: `evt-${i}`,
        occurredAt: new Date(NOW.getTime() + i * 1000),
      });
    }

    const page1 = await service.getBids("auc-2", 1, 2);

    expect(page1.meta.total).toBe(5);
    expect(page1.meta.totalPages).toBe(3);
    expect(page1.data).toHaveLength(2);
    expect(page1.data[0].bidder).toBe("GBIDDER5");
    expect(page1.data[1].bidder).toBe("GBIDDER4");
  });

  it("settles an auction and returns winner + settlement amount", async () => {
    const service = new SecondaryAuctionService(createFakeDataSource(), () => NOW);

    await service.ingestAuctionCreated({
      auctionId: "auc-3",
      seller: "GSELLER",
      reservePrice: "100.0000",
    });
    await service.ingestBidPlaced({
      auctionId: "auc-3",
      bidder: "GWINNER",
      amount: "200.0000",
      eventId: "evt-b1",
    });
    await service.ingestAuctionSettled({
      auctionId: "auc-3",
      eventId: "evt-settle",
      occurredAt: NOW,
    });

    const auction = await service.getAuction("auc-3");

    expect(auction.status).toBe(AuctionStatus.SETTLED);
    expect(auction.winner).toBe("GWINNER");
    expect(auction.settlementAmount).toBe("200.0000");
    expect(auction.settledAt).toBe(NOW.toISOString());
    expect(auction.countdownSeconds).toBeNull();
  });

  it("returns active and settled auctions for an invoice", async () => {
    const service = new SecondaryAuctionService(createFakeDataSource(), () => NOW);

    await service.ingestAuctionCreated({
      auctionId: "auc-active",
      seller: "GSELLER",
      invoiceId: "inv-9",
      reservePrice: "10.0000",
    });
    await service.ingestAuctionCreated({
      auctionId: "auc-done",
      seller: "GSELLER",
      invoiceId: "inv-9",
      reservePrice: "10.0000",
    });
    await service.ingestAuctionSettled({ auctionId: "auc-done" });

    const auctions = await service.getAuctionsForInvoice("inv-9");

    expect(auctions).toHaveLength(2);
    const statuses = auctions.map((a) => a.status).sort();
    expect(statuses).toEqual([AuctionStatus.ACTIVE, AuctionStatus.SETTLED]);
  });

  it("404s for an unknown auction", async () => {
    const service = new SecondaryAuctionService(createFakeDataSource(), () => NOW);

    await expect(service.getAuction("missing")).rejects.toMatchObject({
      code: "AUCTION_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("404s when a bid references an unknown auction", async () => {
    const service = new SecondaryAuctionService(createFakeDataSource(), () => NOW);

    await expect(
      service.ingestBidPlaced({
        auctionId: "missing",
        bidder: "G",
        amount: "1.0000",
      }),
    ).rejects.toMatchObject({ code: "AUCTION_NOT_FOUND", statusCode: 404 });
  });

  describe("Issue #835: Preserve secondary bid ownership during auction close", () => {
    it("locks the auction and winning bid together and persists exactly one winner", async () => {
      const fakeDs = createFakeDataSource();
      const service = new SecondaryAuctionService(fakeDs, () => NOW);

      const endsAt = new Date("2026-03-01T14:00:00Z");
      await service.ingestAuctionCreated({
        auctionId: "auc-lock-1",
        seller: "GSELLER",
        reservePrice: "100.0000",
        startsAt: NOW,
        endsAt,
      });

      await service.ingestBidPlaced({
        auctionId: "auc-lock-1",
        bidder: "GBIDDER1",
        amount: "110.0000",
        occurredAt: new Date("2026-03-01T12:30:00Z"),
      });
      await service.ingestBidPlaced({
        auctionId: "auc-lock-1",
        bidder: "GBIDDER2",
        amount: "250.0000",
        occurredAt: new Date("2026-03-01T13:00:00Z"),
      });
      await service.ingestBidPlaced({
        auctionId: "auc-lock-1",
        bidder: "GBIDDER3",
        amount: "180.0000",
        occurredAt: new Date("2026-03-01T13:30:00Z"),
      });

      // Close auction after endsAt
      const closed = await service.closeAuction({
        auctionId: "auc-lock-1",
        occurredAt: new Date("2026-03-01T14:00:01Z"),
      });

      expect(closed.status).toBe(AuctionStatus.SETTLED);
      expect(closed.winner).toBe("GBIDDER2");
      expect(closed.settlementAmount).toBe("250.0000");

      const view = await service.getAuction("auc-lock-1");
      expect(view.winner).toBe("GBIDDER2");
      expect(view.highestBidder).toBe("GBIDDER2");
      expect(view.settlementAmount).toBe("250.0000");
    });

    it("rejects close before close time (endsAt) with AUCTION_NOT_ENDED", async () => {
      const fakeDs = createFakeDataSource();
      const service = new SecondaryAuctionService(fakeDs, () => NOW);

      const endsAt = new Date("2026-03-01T15:00:00Z");
      await service.ingestAuctionCreated({
        auctionId: "auc-early-close",
        seller: "GSELLER",
        reservePrice: "50.0000",
        startsAt: NOW,
        endsAt,
      });

      // Attempt to close at NOW (before endsAt)
      await expect(
        service.closeAuction({
          auctionId: "auc-early-close",
          occurredAt: NOW,
        }),
      ).rejects.toMatchObject({
        code: "AUCTION_NOT_ENDED",
        statusCode: 400,
      });
    });

    it("rejects close when invoice is matured with INVOICE_MATURED", async () => {
      const maturedInvoice = {
        id: "inv-matured",
        status: InvoiceStatus.SETTLED,
        dueDate: new Date("2026-02-01T00:00:00Z"),
      } as Invoice;

      const fakeDs = createFakeDataSource([], [], [], [maturedInvoice]);
      const service = new SecondaryAuctionService(fakeDs, () => NOW);

      const endsAt = new Date("2026-03-01T13:00:00Z");
      await service.ingestAuctionCreated({
        auctionId: "auc-matured",
        seller: "GSELLER",
        invoiceId: "inv-matured",
        reservePrice: "50.0000",
        startsAt: NOW,
        endsAt,
      });

      await expect(
        service.closeAuction({
          auctionId: "auc-matured",
          occurredAt: new Date("2026-03-01T13:01:00Z"),
        }),
      ).rejects.toMatchObject({
        code: "INVOICE_MATURED",
        statusCode: 422,
      });
    });

    it("atomically creates secondary holding records in Investment upon close", async () => {
      const invoice = {
        id: "inv-atomic",
        status: InvoiceStatus.FUNDED,
        dueDate: new Date("2026-04-01T00:00:00Z"),
      } as Invoice;

      const sellerInvestment = {
        id: "inv-holding-seller",
        invoiceId: "inv-atomic",
        investorWallet: "GSELLER",
        investmentAmount: "300.0000",
        expectedReturn: "300.0000",
        status: InvestmentStatus.CONFIRMED,
      } as Investment;

      const user = {
        id: "user-winner-id",
        stellarAddress: "GBIDDER_WINNER",
      } as User;

      const fakeDs = createFakeDataSource([], [], [sellerInvestment], [invoice], [user]);
      const service = new SecondaryAuctionService(fakeDs, () => NOW);

      const endsAt = new Date("2026-03-01T13:00:00Z");
      await service.ingestAuctionCreated({
        auctionId: "auc-holding",
        seller: "GSELLER",
        invoiceId: "inv-atomic",
        reservePrice: "100.0000",
        startsAt: NOW,
        endsAt,
      });

      await service.ingestBidPlaced({
        auctionId: "auc-holding",
        bidder: "GBIDDER_WINNER",
        amount: "150.0000",
        occurredAt: new Date("2026-03-01T12:30:00Z"),
      });

      await service.closeAuction({
        auctionId: "auc-holding",
        occurredAt: new Date("2026-03-01T13:05:00Z"),
      });

      // Winner holding created
      const winnerInv = fakeDs._state.investmentRows.find(
        (i) => i.investorWallet === "GBIDDER_WINNER" && i.invoiceId === "inv-atomic",
      );
      expect(winnerInv).toBeDefined();
      expect(winnerInv?.investmentAmount).toBe("150.0000");
      expect(winnerInv?.status).toBe(InvestmentStatus.CONFIRMED);
      expect(winnerInv?.investorId).toBe("user-winner-id");

      // Seller holding deducted
      expect(sellerInvestment.investmentAmount).toBe("150.0000");

      // Ownership projection agrees with winning bid
      const ownership = await service.getAuctionOwnership("auc-holding");
      expect(ownership.winner).toBe("GBIDDER_WINNER");
      expect(ownership.settlementAmount).toBe("150.0000");
      expect(ownership.holding?.investmentAmount).toBe("150.0000");
      expect(ownership.status).toBe(AuctionStatus.SETTLED);
    });

    it("late bids fail without state changes", async () => {
      const fakeDs = createFakeDataSource();
      const service = new SecondaryAuctionService(fakeDs, () => NOW);

      const endsAt = new Date("2026-03-01T14:00:00Z");
      await service.ingestAuctionCreated({
        auctionId: "auc-late",
        seller: "GSELLER",
        reservePrice: "50.0000",
        startsAt: NOW,
        endsAt,
      });

      await service.ingestBidPlaced({
        auctionId: "auc-late",
        bidder: "GVALID",
        amount: "100.0000",
        occurredAt: new Date("2026-03-01T13:00:00Z"),
      });

      // 1. Bid placed after endsAt fails
      await expect(
        service.ingestBidPlaced({
          auctionId: "auc-late",
          bidder: "GLATE1",
          amount: "200.0000",
          occurredAt: new Date("2026-03-01T14:00:01Z"),
        }),
      ).rejects.toMatchObject({
        code: "AUCTION_CLOSED",
        statusCode: 400,
      });

      expect(fakeDs._state.bidRows).toHaveLength(1);
      const auction1 = await service.getAuction("auc-late");
      expect(auction1.highestBid).toBe("100.0000");
      expect(auction1.highestBidder).toBe("GVALID");

      // 2. Close auction
      await service.closeAuction({
        auctionId: "auc-late",
        occurredAt: new Date("2026-03-01T14:05:00Z"),
      });

      // 3. Bid placed after auction is settled fails
      await expect(
        service.ingestBidPlaced({
          auctionId: "auc-late",
          bidder: "GLATE2",
          amount: "300.0000",
          occurredAt: new Date("2026-03-01T13:30:00Z"),
        }),
      ).rejects.toMatchObject({
        code: "AUCTION_CLOSED",
        statusCode: 400,
      });

      expect(fakeDs._state.bidRows).toHaveLength(1);
      const auction2 = await service.getAuction("auc-late");
      expect(auction2.winner).toBe("GVALID");
      expect(auction2.highestBid).toBe("100.0000");
    });

    it("auction close retries are idempotent", async () => {
      const invoice = {
        id: "inv-idempotent",
        status: InvoiceStatus.FUNDED,
        dueDate: new Date("2026-05-01T00:00:00Z"),
      } as Invoice;

      const fakeDs = createFakeDataSource([], [], [], [invoice]);
      const service = new SecondaryAuctionService(fakeDs, () => NOW);

      const endsAt = new Date("2026-03-01T13:00:00Z");
      await service.ingestAuctionCreated({
        auctionId: "auc-idempotent",
        seller: "GSELLER",
        invoiceId: "inv-idempotent",
        reservePrice: "50.0000",
        startsAt: NOW,
        endsAt,
      });

      await service.ingestBidPlaced({
        auctionId: "auc-idempotent",
        bidder: "GWON",
        amount: "120.0000",
        occurredAt: new Date("2026-03-01T12:30:00Z"),
      });

      // First close
      const firstClose = await service.closeAuction({
        auctionId: "auc-idempotent",
        occurredAt: new Date("2026-03-01T13:01:00Z"),
      });
      expect(firstClose.status).toBe(AuctionStatus.SETTLED);
      expect(firstClose.winner).toBe("GWON");

      const holdingsCountFirst = fakeDs._state.investmentRows.length;

      // Second close (retry)
      const secondClose = await service.closeAuction({
        auctionId: "auc-idempotent",
        occurredAt: new Date("2026-03-01T13:02:00Z"),
      });
      expect(secondClose.status).toBe(AuctionStatus.SETTLED);
      expect(secondClose.winner).toBe("GWON");

      // No duplicate holding record created
      expect(fakeDs._state.investmentRows.length).toBe(holdingsCountFirst);
      expect(fakeDs._state.investmentRows[0].investmentAmount).toBe("120.0000");
    });

    it("covers replica lag: locked transactional close selects the true winning bid even if replica view is stale", async () => {
      // Setup primary database state
      const invoice = {
        id: "inv-repl",
        status: InvoiceStatus.FUNDED,
        dueDate: new Date("2026-05-01T00:00:00Z"),
      } as Invoice;

      const primaryDs = createFakeDataSource([], [], [], [invoice]);
      const service = new SecondaryAuctionService(primaryDs, () => NOW);

      const endsAt = new Date("2026-03-01T14:00:00Z");
      await service.ingestAuctionCreated({
        auctionId: "auc-repl-lag",
        seller: "GSELLER",
        invoiceId: "inv-repl",
        reservePrice: "100.0000",
        startsAt: NOW,
        endsAt,
      });

      // Bids committed to primary
      await service.ingestBidPlaced({
        auctionId: "auc-repl-lag",
        bidder: "GBIDDER_EARLY",
        amount: "150.0000",
        occurredAt: new Date("2026-03-01T12:30:00Z"),
      });
      await service.ingestBidPlaced({
        auctionId: "auc-repl-lag",
        bidder: "GBIDDER_LATEST",
        amount: "280.0000",
        occurredAt: new Date("2026-03-01T13:45:00Z"),
      });

      // Simulate a read-replica view that is lagging behind primary (missing latest bid GBIDDER_LATEST)
      const staleReplicaBids = primaryDs._state.bidRows.filter(
        (b) => b.bidder !== "GBIDDER_LATEST",
      );
      expect(staleReplicaBids).toHaveLength(1);
      expect(staleReplicaBids[0].bidder).toBe("GBIDDER_EARLY");

      // When auction close executes, it locks on primary (transactional manager)
      // and selects GBIDDER_LATEST ($280) rather than the stale replica state
      const closed = await service.closeAuction({
        auctionId: "auc-repl-lag",
        occurredAt: new Date("2026-03-01T14:01:00Z"),
      });

      // Exactly one winner is persisted on primary matching the true winning bid
      expect(closed.winner).toBe("GBIDDER_LATEST");
      expect(closed.settlementAmount).toBe("280.0000");

      // Ownership projection agrees with the winning bid, not the stale replica
      const ownership = await service.getAuctionOwnership("auc-repl-lag");
      expect(ownership.winner).toBe("GBIDDER_LATEST");
      expect(ownership.holding?.investorWallet).toBe("GBIDDER_LATEST");
      expect(ownership.holding?.investmentAmount).toBe("280.0000");

      // Concurrent late bid submitted to primary fails without modifying state
      await expect(
        service.ingestBidPlaced({
          auctionId: "auc-repl-lag",
          bidder: "GBIDDER_RACE",
          amount: "350.0000",
          occurredAt: new Date("2026-03-01T14:02:00Z"),
        }),
      ).rejects.toMatchObject({
        code: "AUCTION_CLOSED",
        statusCode: 400,
      });

      // Winner remains unchanged
      const finalView = await service.getAuction("auc-repl-lag");
      expect(finalView.winner).toBe("GBIDDER_LATEST");
      expect(finalView.highestBid).toBe("280.0000");
    });
  });
});
