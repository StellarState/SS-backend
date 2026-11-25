import { randomUUID } from "node:crypto";
import { DataSource, EntityManager } from "typeorm";
import { Decimal } from "decimal.js";
import { reliabilityDatabase, closeReliabilityDatabase } from "../helpers/postgres-reliability";
import { SecondaryMarketService } from "../../src/services/secondary-market.service";
import { PortfolioService } from "../../src/services/portfolio.service";
import { Invoice } from "../../src/models/Invoice.model";
import { User } from "../../src/models/User.model";
import { Investment } from "../../src/models/Investment.model";
import { SecondaryListing } from "../../src/models/SecondaryListing.model";
import { SecondaryTrade } from "../../src/models/SecondaryTrade.model";
import { Transaction } from "../../src/models/Transaction.model";
import { SettlementIntent, SettlementIntentStatus } from "../../src/models/SettlementIntent.model";
import {
  InvoiceStatus,
  InvestmentStatus,
  KYCStatus,
  ListingStatus,
  UserType,
} from "../../src/types/enums";

/**
 * Secondary purchase integrity against PostgreSQL (issues #747–#750).
 * Skipped without DATABASE_URL, like the other reliability suites.
 */
const suite = process.env.DATABASE_URL ? describe : describe.skip;

/** Invoice due date used throughout; trading closes at its 00:00:00Z. */
const DUE_DATE = "2030-06-15";
const CUTOFF = new Date(`${DUE_DATE}T00:00:00.000Z`);
const BEFORE = new Date("2030-06-01T12:00:00.000Z");

suite("secondary purchase integrity (#747, #748, #749, #750)", () => {
  let source: DataSource;
  let clock: Date;
  let market: SecondaryMarketService;
  let invoice: Invoice;
  let seller: User;
  let buyer: User;
  let secondBuyer: User;

  beforeAll(async () => {
    source = await reliabilityDatabase();
  }, 60_000);

  afterAll(async () => {
    if (source) await closeReliabilityDatabase(source);
  });

  afterEach(() => jest.restoreAllMocks());

  const newUser = () =>
    source.getRepository(User).save({
      stellarAddress: `G${randomUUID().replace(/-/g, "").toUpperCase()}`,
      userType: UserType.INVESTOR,
      kycStatus: KYCStatus.APPROVED,
    });

  async function setup(seller_: { principal: string; expectedReturn: string }) {
    clock = BEFORE;
    market = new SecondaryMarketService(source, undefined, { now: () => clock });
    seller = await newUser();
    buyer = await newUser();
    secondBuyer = await newUser();
    invoice = await source.getRepository(Invoice).save({
      sellerId: seller.id,
      invoiceNumber: randomUUID(),
      customerName: "Customer",
      amount: seller_.expectedReturn,
      discountRate: "0",
      netAmount: seller_.principal,
      dueDate: DUE_DATE as unknown as Date,
      status: InvoiceStatus.FUNDED,
    });
    await source.getRepository(Investment).save({
      invoiceId: invoice.id,
      investorId: seller.id,
      investorWallet: seller.stellarAddress,
      investmentAmount: seller_.principal,
      expectedReturn: seller_.expectedReturn,
      status: InvestmentStatus.CONFIRMED,
    });
  }

  const list = (quantity: string, price = "1", expiresAt?: Date) =>
    market.createListing({
      invoiceId: invoice.id,
      sellerWallet: seller.stellarAddress,
      sellerId: seller.id,
      quantity,
      pricePerFraction: price,
      expiresAt,
    });

  const buy = (listingId: string, who: User = buyer, quantity?: string) =>
    market.buyListing({
      listingId,
      buyerWallet: who.stellarAddress,
      buyerId: who.id,
      quantity,
    });

  const holding = async (user: User) => {
    const row = await source
      .getRepository(Investment)
      .findOne({ where: { invoiceId: invoice.id, investorId: user.id } });
    return row ? { principal: row.investmentAmount, expectedReturn: row.expectedReturn } : null;
  };

  /** Everything a purchase may write, to prove a rejected one wrote nothing. */
  const snapshot = async () => ({
    listings: await source
      .getRepository(SecondaryListing)
      .find({ where: { invoiceId: invoice.id }, order: { id: "ASC" } })
      .then((rows) => rows.map((l) => [l.id, l.status, l.quantity, l.totalPrice, l.version])),
    investments: await source
      .getRepository(Investment)
      .find({ where: { invoiceId: invoice.id }, order: { id: "ASC" } })
      .then((rows) =>
        rows.map((i) => [i.investorId, i.investmentAmount, i.expectedReturn, i.version])
      ),
    trades: await source.getRepository(SecondaryTrade).count({ where: { invoiceId: invoice.id } }),
    transactions: await source
      .getRepository(Transaction)
      .count({ where: { invoiceId: invoice.id } }),
  });

  const totalPrincipal = async () =>
    (
      await source
        .getRepository(Investment)
        .find({ where: { invoiceId: invoice.id, status: InvestmentStatus.CONFIRMED } })
    ).reduce((sum, i) => sum.plus(i.investmentAmount), new Decimal(0));

  // ---------------------------------------------------------------- #747
  describe("maturity at purchase (#747)", () => {
    beforeEach(() => setup({ principal: "1000.0000", expectedReturn: "1000.0000" }));

    it("rejects buying an existing listing once the invoice matures, while it stays FUNDED and the listing unexpired", async () => {
      const row = await list("100");
      // A listing from before this rule, expiring after maturity.
      await source
        .getRepository(SecondaryListing)
        .update(row.id, { expiresAt: new Date("2030-12-31T00:00:00Z") });
      const before = await snapshot();

      clock = new Date("2030-06-20T00:00:00Z"); // past maturity
      await expect(buy(row.id)).rejects.toMatchObject({
        code: "INVOICE_MATURED",
        statusCode: 422,
        details: { trading_cutoff: CUTOFF.toISOString() },
      });

      expect(await snapshot()).toEqual(before);
      expect((await source.getRepository(Invoice).findOneByOrFail({ id: invoice.id })).status).toBe(
        InvoiceStatus.FUNDED
      );
    });

    it("keeps listings purchasable before maturity", async () => {
      const row = await list("100");
      clock = new Date(CUTOFF.getTime() - 60_000);
      await expect(buy(row.id)).resolves.toMatchObject({ listingStatus: ListingStatus.SOLD });
    });

    it("creation and purchase agree at the exact cutoff", async () => {
      const row = await list("100");

      clock = new Date(CUTOFF.getTime() - 1);
      const late = await list("50");
      await expect(buy(late.id, buyer, "1")).resolves.toBeDefined();

      clock = CUTOFF;
      await expect(list("10")).rejects.toMatchObject({ code: "INVOICE_MATURED", statusCode: 422 });
      await expect(buy(row.id)).rejects.toMatchObject({ code: "INVOICE_MATURED", statusCode: 422 });
    });

    it("bounds custom listing expiry by the trading cutoff", async () => {
      await expect(list("10", "1", new Date(CUTOFF.getTime() + 1))).rejects.toMatchObject({
        code: "INVALID_EXPIRY",
        statusCode: 400,
      });
      const atCutoff = await list("10", "1", CUTOFF);
      expect(atCutoff.expiresAt.toISOString()).toBe(CUTOFF.toISOString());
      const byDefault = await list("10");
      expect(byDefault.expiresAt.toISOString()).toBe(CUTOFF.toISOString());
    });

    it("hides listings on matured invoices from the browse endpoint", async () => {
      const row = await list("100");
      await source
        .getRepository(SecondaryListing)
        .update(row.id, { expiresAt: new Date("2030-12-31T00:00:00Z") });
      expect((await market.getListings({ invoiceId: invoice.id })).data).toHaveLength(1);
      clock = CUTOFF;
      expect((await market.getListings({ invoiceId: invoice.id })).data).toHaveLength(0);
    });

    it("still rejects purchases while settlement is in progress", async () => {
      const row = await list("100");
      await source.getRepository(SettlementIntent).save({
        invoiceId: invoice.id,
        status: SettlementIntentStatus.PREPARED,
        payload: "{}",
      });
      const before = await snapshot();
      await expect(buy(row.id)).rejects.toMatchObject({ code: "SETTLEMENT_IN_PROGRESS" });
      expect(await snapshot()).toEqual(before);
    });
  });

  // ---------------------------------------------------------------- #748
  describe("cancellation against purchase (#748)", () => {
    beforeEach(() => setup({ principal: "1000.0000", expectedReturn: "1050.0000" }));

    /**
     * Pauses the first transaction that reaches `entity` after the listing
     * row lock, so the other operation arrives at the listing read while the
     * lock is held.
     */
    function pauseAt(entity: unknown) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const arrived = new Promise<void>((resolve) => (reached = resolve));
      let armed = true;
      const original = EntityManager.prototype.findOne;
      jest.spyOn(EntityManager.prototype, "findOne").mockImplementation(async function (
        this: EntityManager,
        ...args: Parameters<EntityManager["findOne"]>
      ) {
        if (armed && args[0] === entity) {
          armed = false;
          reached();
          await gate;
        }
        return original.apply(this, args);
      } as EntityManager["findOne"]);
      return { arrived, release };
    }

    const notSettledYet = (promise: Promise<unknown>) =>
      Promise.race([
        promise.then(
          () => "settled",
          () => "settled"
        ),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 300)),
      ]);

    it("purchase holding the listing wins; the waiting cancellation gets a conflict and changes nothing", async () => {
      const row = await list("100");
      const { arrived, release } = pauseAt(Invoice); // buy has locked the listing
      const purchase = buy(row.id);
      await arrived;

      const cancel = market.cancelListing(
        row.id,
        seller.stellarAddress,
        "stale",
        seller.id,
        row.version
      );
      expect(await notSettledYet(cancel)).toBe("pending"); // blocked on the listing lock

      release();
      await expect(purchase).resolves.toMatchObject({ listingStatus: ListingStatus.SOLD });
      await expect(cancel).rejects.toMatchObject({ code: "LISTING_CONFLICT", statusCode: 409 });

      const final = await source.getRepository(SecondaryListing).findOneByOrFail({ id: row.id });
      expect(final.status).toBe(ListingStatus.SOLD);
      expect(final.cancellationReason).toBeNull();
      expect(await holding(buyer)).toEqual({ principal: "100.0000", expectedReturn: "105.0000" });
      expect(
        await source.getRepository(SecondaryTrade).count({ where: { listingId: row.id } })
      ).toBe(1);
    });

    it("cancellation holding the listing wins; the waiting purchase is rejected with no records", async () => {
      const row = await list("100");
      const { arrived, release } = pauseAt(SecondaryTrade); // cancel has locked the listing
      const cancel = market.cancelListing(
        row.id,
        seller.stellarAddress,
        "changed my mind",
        seller.id,
        row.version
      );
      await arrived;
      const before = await snapshot();

      const purchase = buy(row.id);
      expect(await notSettledYet(purchase)).toBe("pending");

      release();
      await expect(cancel).resolves.toMatchObject({ status: ListingStatus.CANCELLED });
      await expect(purchase).rejects.toMatchObject({ code: "LISTING_NOT_ACTIVE" });

      const after = await snapshot();
      expect(after.investments).toEqual(before.investments);
      expect(after.trades).toBe(0);
      expect(after.transactions).toBe(0);
      expect(await holding(buyer)).toBeNull();
    });

    it("a stale cancellation after a partial fill cannot restore the old quantity", async () => {
      const row = await list("100");
      await buy(row.id, buyer, "40");

      await expect(
        market.cancelListing(row.id, seller.stellarAddress, "stale", seller.id, row.version)
      ).rejects.toMatchObject({ code: "LISTING_CONFLICT", statusCode: 409 });

      const final = await source.getRepository(SecondaryListing).findOneByOrFail({ id: row.id });
      expect(final).toMatchObject({
        status: ListingStatus.ACTIVE,
        quantity: "60.0000",
        totalPrice: "60.0000",
      });
    });

    it("an unauthorized cancellation makes no changes", async () => {
      const row = await list("100");
      const before = await snapshot();
      await expect(
        market.cancelListing(row.id, buyer.stellarAddress, "not mine", buyer.id, row.version)
      ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
      expect(await snapshot()).toEqual(before);
    });
  });

  // ---------------------------------------------------------------- #749
  describe("expected-return entitlement moves with principal (#749)", () => {
    it("reallocates on a discounted invoice across partial, repeated and full fills, above and below par", async () => {
      // Bought at a discount: 1000 principal, 1050 expected at settlement.
      await setup({ principal: "1000.0000", expectedReturn: "1050.0000" });

      const a = await list("250", "0.9000"); // below principal value
      await buy(a.id);
      expect(await holding(seller)).toEqual({ principal: "750.0000", expectedReturn: "787.5000" });
      expect(await holding(buyer)).toEqual({ principal: "250.0000", expectedReturn: "262.5000" });

      const b = await list("250", "1.2000"); // above principal value; existing buyer
      await buy(b.id);
      expect(await holding(seller)).toEqual({ principal: "500.0000", expectedReturn: "525.0000" });
      expect(await holding(buyer)).toEqual({ principal: "500.0000", expectedReturn: "525.0000" });

      const c = await list("500", "1.0000"); // full exit to a second buyer
      await buy(c.id, secondBuyer);
      expect(await holding(seller)).toEqual({ principal: "0.0000", expectedReturn: "0.0000" });
      expect(await holding(secondBuyer)).toEqual({
        principal: "500.0000",
        expectedReturn: "525.0000",
      });

      // The price paid is the trade's business, not the settlement claim.
      const trades = await source
        .getRepository(SecondaryTrade)
        .find({ where: { invoiceId: invoice.id }, order: { createdAt: "ASC" } });
      expect(trades.map((t) => t.grossAmount)).toEqual(["225.0000", "300.0000", "500.0000"]);
    });

    it("conserves entitlement exactly under rounding, with the dust following the last fill", async () => {
      // 3 units entitled to 3.1000: a third is 1.0333…, rounded down.
      await setup({ principal: "3.0000", expectedReturn: "3.1000" });
      const row = await list("3");
      await buy(row.id, buyer, "1");
      await buy(row.id, secondBuyer, "1");
      expect(await holding(seller)).toEqual({ principal: "1.0000", expectedReturn: "1.0334" });
      await buy(row.id, buyer, "1");

      const rows = await source
        .getRepository(Investment)
        .find({ where: { invoiceId: invoice.id } });
      const total = rows.reduce((sum, r) => sum.plus(r.expectedReturn), new Decimal(0));
      expect(total.toFixed(4)).toBe("3.1000");
      expect(await holding(seller)).toEqual({ principal: "0.0000", expectedReturn: "0.0000" });
      expect(await holding(buyer)).toEqual({ principal: "2.0000", expectedReturn: "2.0667" });
      expect(await holding(secondBuyer)).toEqual({ principal: "1.0000", expectedReturn: "1.0333" });
    });

    it("portfolio values follow the new ownership", async () => {
      await setup({ principal: "1000.0000", expectedReturn: "1050.0000" });
      const row = await list("1000", "0.9500");
      await buy(row.id);

      const portfolio = new PortfolioService(source);
      expect((await portfolio.getPortfolio(seller.id)).summary.currentPortfolioValue).toBe(
        "0.0000"
      );
      expect((await portfolio.getPortfolio(buyer.id)).summary).toMatchObject({
        totalInvested: "1000.0000",
        currentPortfolioValue: "1050.0000",
      });
    });
  });

  // ---------------------------------------------------------------- #750
  describe("purchase conservation and rollback (#750)", () => {
    beforeEach(() => setup({ principal: "60.0000", expectedReturn: "63.0000" }));

    async function seedUnbackedListing(quantity: string) {
      // Drift: a listing larger than the seller's holdings, written directly.
      return source.getRepository(SecondaryListing).save({
        invoiceId: invoice.id,
        sellerWallet: seller.stellarAddress,
        sellerId: seller.id,
        quantity,
        pricePerFraction: "1.0000",
        totalPrice: quantity,
        status: ListingStatus.ACTIVE,
        expiresAt: CUTOFF,
      });
    }

    it("a 100-unit listing backed by 60 units credits nothing and leaves every row as it was", async () => {
      const row = await seedUnbackedListing("100.0000");
      const before = await snapshot();

      await expect(buy(row.id)).rejects.toMatchObject({ statusCode: 409 });

      expect(await snapshot()).toEqual(before);
      expect(await holding(buyer)).toBeNull();
    });

    it("rolls back the listing and every investment write when the purchase fails after them", async () => {
      const row = await seedUnbackedListing("50.0000");
      const before = await snapshot();
      // Fail the trade insert, which runs after the listing update, the
      // seller deductions and the buyer credit.
      const schema = (source.options as { schema: string }).schema;
      await source.query(`
        CREATE FUNCTION "${schema}".fail_trade() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_trade BEFORE INSERT ON "${schema}"."secondary_trades"
          FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_trade();
      `);
      try {
        await expect(buy(row.id, buyer, "50")).rejects.toThrow(/injected failure/);
      } finally {
        await source.query(`DROP TRIGGER fail_trade ON "${schema}"."secondary_trades"`);
        await source.query(`DROP FUNCTION "${schema}".fail_trade()`);
      }

      expect(await snapshot()).toEqual(before);
      expect(await holding(buyer)).toBeNull();
    });

    it("fully backed partial and full fills succeed and conserve total principal", async () => {
      const total = await totalPrincipal();
      const row = await list("60");
      await buy(row.id, buyer, "25");
      expect((await totalPrincipal()).eq(total)).toBe(true);
      await buy(row.id, secondBuyer);
      expect((await totalPrincipal()).eq(total)).toBe(true);
      expect(await holding(seller)).toEqual({ principal: "0.0000", expectedReturn: "0.0000" });
      expect(await holding(buyer)).toEqual({ principal: "25.0000", expectedReturn: "26.2500" });
      expect(await holding(secondBuyer)).toEqual({
        principal: "35.0000",
        expectedReturn: "36.7500",
      });
    });
  });
});
