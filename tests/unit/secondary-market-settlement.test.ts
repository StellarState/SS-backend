import request from "supertest";
import express from "express";
import {
  DEFAULT_SECONDARY_MARKET_FEE_BPS,
  SecondaryMarketService,
  createLockUpOnFundingEffect,
  transitionListing,
} from "../../src/services/secondary-market.service";
import { createSecondaryMarketRouter } from "../../src/routes/secondary-market.routes";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { SecondaryListing } from "../../src/models/SecondaryListing.model";
import { SecondaryTrade } from "../../src/models/SecondaryTrade.model";
import { Transaction } from "../../src/models/Transaction.model";
import { User } from "../../src/models/User.model";
import {
  InvestmentStatus,
  InvoiceStatus,
  KYCStatus,
  ListingStatus,
  UserType,
} from "../../src/types/enums";
import { ServiceError } from "../../src/utils/service-error";
import type { InvoiceTransition } from "../../src/lib/invoice-state-machine";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const SELLER_ID = "seller-id";
const SELLER_WALLET = "GSELLER";
const BUYER_ID = "buyer-id";
const BUYER_WALLET = "GBUYER";
const ISSUER_ID = "issuer-id";
const ISSUER_WALLET = "GISSUER";

interface State {
  invoice: Record<string, unknown>;
  investments: Array<Record<string, unknown>>;
  listings: Array<Record<string, unknown>>;
  saved: Array<{ entity: unknown; value: Record<string, unknown> }>;
}

function newState(overrides: { invoice?: Record<string, unknown> } = {}): State {
  return {
    invoice: {
      id: "invoice-1",
      status: InvoiceStatus.FUNDED,
      sellerId: ISSUER_ID,
      sellerWallet: null,
      dueDate: new Date("2027-01-01"),
      lockUpExpiry: null,
      secondaryRoyaltyBps: 0,
      ...overrides.invoice,
    },
    investments: [
      {
        id: "inv-seller",
        invoiceId: "invoice-1",
        investorId: SELLER_ID,
        investorWallet: SELLER_WALLET,
        investmentAmount: "100.0000",
        status: InvestmentStatus.CONFIRMED,
      },
    ],
    listings: [],
    saved: [],
  };
}

function listing(state: State, overrides: Record<string, unknown> = {}) {
  const row = {
    id: `listing-${state.listings.length + 1}`,
    invoiceId: "invoice-1",
    sellerWallet: SELLER_WALLET,
    sellerId: SELLER_ID,
    quantity: "50.0000",
    pricePerFraction: "1.2345",
    version: 1,
    totalPrice: "61.7250",
    status: ListingStatus.ACTIVE,
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    ...overrides,
  };
  state.listings.push(row);
  return row;
}

function fakeDataSource(state: State) {
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => typeof v === "object" || row[k] === v);

  const manager = {
    findOne: jest.fn(async (entity: unknown, options: { where: Record<string, unknown> }) => {
      const where = options.where;
      if (entity === SecondaryListing) return state.listings.find((l) => l.id === where.id) ?? null;
      if (entity === Invoice) return where.id === state.invoice.id ? state.invoice : null;
      if (entity === Investment) return state.investments.find((i) => matches(i, where)) ?? null;
      if (entity === User) {
        return where.id === ISSUER_ID ? { id: ISSUER_ID, stellarAddress: ISSUER_WALLET } : null;
      }
      return null;
    }),
    find: jest.fn(async (entity: unknown, options: { where: unknown }) => {
      const wheres = (Array.isArray(options.where) ? options.where : [options.where]) as Array<
        Record<string, unknown>
      >;
      const rows = entity === Investment ? state.investments : state.listings;
      return rows.filter((r) => wheres.some((w) => matches(r, w)));
    }),
    create: jest.fn((_entity: unknown, values: Record<string, unknown>) => ({
      __entity: _entity,
      ...values,
    })),
    save: jest.fn(async (value: Record<string, unknown>) => {
      const entity = value.__entity;
      if (entity === Investment && !value.id) {
        value.id = `inv-${state.investments.length + 1}`;
        state.investments.push(value);
      } else if (entity === SecondaryListing && !value.id) {
        value.id = `listing-${state.listings.length + 1}`;
        state.listings.push(value);
      } else if (entity === SecondaryTrade) {
        value.id = "trade-1";
      }
      state.saved.push({ entity, value });
      return value;
    }),
  };

  return {
    manager,
    dataSource: {
      transaction: jest.fn(async (cb: (m: typeof manager) => unknown) => cb(manager)),
    } as never,
  };
}

function service(state: State, feeBps: number | Error | null = 150) {
  const { dataSource, manager } = fakeDataSource(state);
  const feeSchedule =
    feeBps === null
      ? undefined
      : {
          getFeeRate: jest.fn(async () => {
            if (feeBps instanceof Error) throw feeBps;
            return feeBps;
          }),
        };
  return {
    manager,
    svc: new SecondaryMarketService(dataSource, undefined, { feeSchedule, now: () => NOW }),
  };
}

const savedOf = (state: State, entity: unknown) =>
  state.saved.filter((s) => s.entity === entity).map((s) => s.value);

describe("secondary market lock-up (issue #783)", () => {
  it("rejects listing during lock-up with the accurate remaining seconds", async () => {
    const state = newState({
      invoice: { lockUpExpiry: new Date(NOW.getTime() + 90_500) },
    });
    const { svc } = service(state);

    const error = await svc
      .createListing({
        invoiceId: "invoice-1",
        sellerWallet: SELLER_WALLET,
        sellerId: SELLER_ID,
        quantity: "10",
        pricePerFraction: "1",
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({
      code: "LOCK_UP_ACTIVE",
      statusCode: 422,
      details: {
        lock_up_remaining_seconds: 91,
        lock_up_expiry: new Date(NOW.getTime() + 90_500).toISOString(),
      },
    });
  });

  it("allows listing once the lock-up has passed", async () => {
    const state = newState({ invoice: { lockUpExpiry: new Date(NOW.getTime() - 1) } });
    const { svc } = service(state);

    const created = await svc.createListing({
      invoiceId: "invoice-1",
      sellerWallet: SELLER_WALLET,
      sellerId: SELLER_ID,
      quantity: "10",
      pricePerFraction: "1",
    });
    expect(created.status).toBe(ListingStatus.ACTIVE);
  });

  it("stamps the lock-up expiry when an invoice is funded", async () => {
    const execute = jest.fn().mockResolvedValue({ affected: 1 });
    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute,
    };
    const dataSource = { createQueryBuilder: jest.fn(() => qb) } as never;
    const transition = {
      to: InvoiceStatus.FUNDED,
      invoice: { id: "invoice-1" },
      occurredAt: NOW,
    } as unknown as InvoiceTransition;

    await createLockUpOnFundingEffect(dataSource, 3600)(transition);
    expect(qb.set).toHaveBeenCalledWith({ lockUpExpiry: new Date(NOW.getTime() + 3_600_000) });
    expect(qb.andWhere).toHaveBeenCalledWith("lock_up_expiry IS NULL");

    execute.mockClear();
    await createLockUpOnFundingEffect(dataSource, 0)(transition);
    await createLockUpOnFundingEffect(
      dataSource,
      3600
    )({
      ...transition,
      to: InvoiceStatus.SETTLED,
    } as InvoiceTransition);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["non-numeric", "abc", "INVALID_QUANTITY"],
    ["too many decimals", "1.00001", "INVALID_QUANTITY"],
    ["negative", "-1", "INVALID_QUANTITY"],
  ])("rejects a %s fractions value", async (_label, quantity, code) => {
    const { svc } = service(newState());
    await expect(
      svc.createListing({
        invoiceId: "invoice-1",
        sellerWallet: SELLER_WALLET,
        quantity,
        pricePerFraction: "1",
      })
    ).rejects.toMatchObject({ code, statusCode: 400 });
  });
});

describe("secondary market purchase settlement (issue #783)", () => {
  it("transfers fractions and deducts platform fee and issuer royalty", async () => {
    const state = newState({ invoice: { secondaryRoyaltyBps: 250 } });
    const row = listing(state);
    const { svc } = service(state, 150);

    const result = await svc.buyListing({
      listingId: row.id,
      buyerWallet: BUYER_WALLET,
      buyerId: BUYER_ID,
      quantity: "20",
    });

    // 20 x 1.2345 = 24.69; fee 1.5% = 0.37035 -> 0.3704; royalty 2.5% = 0.61725 -> 0.6173
    expect(result).toMatchObject({
      quantity: "20.0000",
      totalPrice: "24.6900",
      platformFeeBps: 150,
      platformFee: "0.3704",
      royaltyBps: 250,
      royalty: "0.6173",
      royaltyRecipientWallet: ISSUER_WALLET,
      sellerProceeds: "23.7023",
      listingStatus: ListingStatus.ACTIVE,
      remainingQuantity: "30.0000",
    });

    const sellerHolding = state.investments.find((i) => i.investorId === SELLER_ID)!;
    const buyerHolding = state.investments.find((i) => i.investorId === BUYER_ID)!;
    expect(sellerHolding.investmentAmount).toBe("80.0000");
    expect(buyerHolding).toMatchObject({
      investmentAmount: "20.0000",
      investorWallet: BUYER_WALLET,
    });

    const [trade] = savedOf(state, SecondaryTrade);
    expect(trade).toMatchObject({
      fractions: "20.0000",
      grossAmount: "24.6900",
      platformFeeAmount: "0.3704",
      royaltyAmount: "0.6173",
      sellerProceeds: "23.7023",
    });

    const payments = savedOf(state, Transaction).map((t) => [t.userId, t.amount]);
    expect(payments).toEqual([
      [BUYER_ID, "24.6900"],
      [SELLER_ID, "23.7023"],
      [ISSUER_ID, "0.6173"],
    ]);
  });

  it("charges no royalty when the invoice has none configured", async () => {
    const state = newState();
    const row = listing(state, { quantity: "10.0000", pricePerFraction: "2.0000" });
    const { svc } = service(state, 100);

    const result = await svc.buyListing({
      listingId: row.id,
      buyerWallet: BUYER_WALLET,
      buyerId: BUYER_ID,
    });

    expect(result).toMatchObject({
      totalPrice: "20.0000",
      platformFee: "0.2000",
      royalty: "0.0000",
      royaltyRecipientWallet: null,
      sellerProceeds: "19.8000",
      listingStatus: ListingStatus.SOLD,
    });
    expect(savedOf(state, Transaction)).toHaveLength(2);
  });

  it("falls back to the default fee when no fee schedule is active", async () => {
    const state = newState();
    const row = listing(state, { quantity: "10.0000", pricePerFraction: "10.0000" });
    const { svc } = service(
      state,
      new ServiceError("NO_ACTIVE_FEE_SCHEDULE", "No active fee schedule found", 404)
    );

    const result = await svc.buyListing({
      listingId: row.id,
      buyerWallet: BUYER_WALLET,
      buyerId: BUYER_ID,
    });
    expect(result.platformFeeBps).toBe(DEFAULT_SECONDARY_MARKET_FEE_BPS);
    expect(result.platformFee).toBe("1.5000");
  });

  it("rejects a purchase the seller can no longer cover", async () => {
    const state = newState();
    state.investments[0].investmentAmount = "5.0000";
    const row = listing(state, { quantity: "10.0000" });
    const { svc } = service(state);

    await expect(
      svc.buyListing({ listingId: row.id, buyerWallet: BUYER_WALLET, buyerId: BUYER_ID })
    ).rejects.toMatchObject({ code: "SELLER_HOLDINGS_INSUFFICIENT", statusCode: 409 });
    expect(row.status).toBe(ListingStatus.ACTIVE);
  });

  it("locks the listing, invoice and seller holdings for update", async () => {
    const state = newState();
    const row = listing(state);
    const { svc, manager } = service(state);

    await svc.buyListing({ listingId: row.id, buyerWallet: BUYER_WALLET, buyerId: BUYER_ID });

    const lock = { mode: "pessimistic_write" };
    expect(manager.findOne).toHaveBeenCalledWith(
      SecondaryListing,
      expect.objectContaining({ lock })
    );
    expect(manager.findOne).toHaveBeenCalledWith(Invoice, expect.objectContaining({ lock }));
    expect(manager.find).toHaveBeenCalledWith(Investment, expect.objectContaining({ lock }));
  });

  it("moves an expired active listing to expired and rejects the purchase", async () => {
    const state = newState();
    const row = listing(state, { expiresAt: new Date(NOW.getTime() - 1000) });
    const { svc } = service(state);

    await expect(
      svc.buyListing({ listingId: row.id, buyerWallet: BUYER_WALLET, buyerId: BUYER_ID })
    ).rejects.toMatchObject({ code: "LISTING_EXPIRED", statusCode: 400 });
    expect(row.status).toBe(ListingStatus.EXPIRED);
    expect(savedOf(state, Transaction)).toHaveLength(0);
  });

  it("moves an expired listing to expired instead of cancelling it", async () => {
    const state = newState();
    const row = listing(state, { expiresAt: new Date(NOW.getTime() - 1000) });
    const { svc } = service(state);

    await expect(
      svc.cancelListing(row.id, SELLER_WALLET, undefined, SELLER_ID, 1)
    ).rejects.toMatchObject({ code: "LISTING_EXPIRED" });
    expect(row.status).toBe(ListingStatus.EXPIRED);
  });
});

describe("listing status transitions (issue #783)", () => {
  it.each([ListingStatus.SOLD, ListingStatus.CANCELLED, ListingStatus.EXPIRED])(
    "allows active -> %s",
    (to) => {
      const row = { status: ListingStatus.ACTIVE } as SecondaryListing;
      transitionListing(row, to);
      expect(row.status).toBe(to);
    }
  );

  it.each([ListingStatus.SOLD, ListingStatus.CANCELLED, ListingStatus.EXPIRED])(
    "treats %s as terminal",
    (from) => {
      for (const to of Object.values(ListingStatus)) {
        const row = { status: from } as SecondaryListing;
        expect(() => transitionListing(row, to)).toThrow(
          expect.objectContaining({ code: "INVALID_LISTING_TRANSITION", statusCode: 409 })
        );
      }
    }
  );
});

describe("secondary market HTTP contract (issue #783)", () => {
  function buildApp(svc: SecondaryMarketService) {
    const authService = {
      getCurrentUser: jest.fn().mockResolvedValue({
        id: BUYER_ID,
        stellarAddress: BUYER_WALLET,
        userType: UserType.INVESTOR,
        kycStatus: KYCStatus.APPROVED,
      }),
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/api/v1/secondary",
      createSecondaryMarketRouter({
        secondaryMarketService: svc,
        authService: authService as never,
      })
    );
    return app;
  }

  it("POST /secondary/listings accepts invoice_id, fractions and ask_price_per_fraction", async () => {
    const state = newState();
    state.investments[0].investorId = BUYER_ID;
    state.investments[0].investorWallet = BUYER_WALLET;
    const { svc } = service(state);

    const res = await request(buildApp(svc))
      .post("/api/v1/secondary/listings")
      .set("Authorization", "Bearer token")
      .send({ invoice_id: "invoice-1", fractions: "12.5", ask_price_per_fraction: "1.1" })
      .expect(201);

    expect(res.body.data).toMatchObject({
      quantity: "12.5000",
      pricePerFraction: "1.1000",
      totalPrice: "13.7500",
      status: ListingStatus.ACTIVE,
    });
  });

  it("returns lock_up_remaining_seconds in the error body", async () => {
    const state = newState({ invoice: { lockUpExpiry: new Date(NOW.getTime() + 60_000) } });
    const { svc } = service(state);

    const res = await request(buildApp(svc))
      .post("/api/v1/secondary/listings")
      .set("Authorization", "Bearer token")
      .send({ invoice_id: "invoice-1", fractions: "1", ask_price_per_fraction: "1" })
      .expect(422);

    expect(res.body.error.code).toBe("LOCK_UP_ACTIVE");
    expect(res.body.error.details.lock_up_remaining_seconds).toBe(60);
  });

  it("POST /secondary/listings/:id/purchase executes the purchase", async () => {
    const state = newState();
    const row = listing(state, { quantity: "10.0000", pricePerFraction: "2.0000" });
    const { svc } = service(state, 0);

    const res = await request(buildApp(svc))
      .post(`/api/v1/secondary/listings/${row.id}/purchase`)
      .set("Authorization", "Bearer token")
      .send({ fractions: 4 })
      .expect(200);

    expect(res.body.data).toMatchObject({
      quantity: "4.0000",
      totalPrice: "8.0000",
      sellerProceeds: "8.0000",
      remainingQuantity: "6.0000",
    });
  });

  it("returns 500 without leaking internals for unexpected errors", async () => {
    const svc = {
      buyListing: jest.fn().mockRejectedValue(new Error("connection reset by peer")),
    } as unknown as SecondaryMarketService;

    const res = await request(buildApp(svc))
      .post("/api/v1/secondary/listings/listing-1/purchase")
      .set("Authorization", "Bearer token")
      .send({})
      .expect(500);
    expect(res.body.error).toEqual({ code: "INTERNAL_ERROR", message: "Internal server error" });
  });
});
