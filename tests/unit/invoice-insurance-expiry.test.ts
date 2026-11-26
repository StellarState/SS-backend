import { DataSource } from "typeorm";
import {
  InvoiceInsuranceService,
  isPolicyActiveAt,
} from "../../src/services/invoice-insurance.service";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const NOW_SECONDS = NOW.getTime() / 1000;
const WALLET = "GWALLET0000000000000000000000000000000000000000000000000000AA";

interface FakePolicyRow {
  invoice_id: string;
  wallet: string;
  is_active: boolean;
  coverage_bps: number;
  premium_paid: string;
  expiry: number;
  purchased_at: number;
}

function makeRow(overrides: Partial<FakePolicyRow> = {}): FakePolicyRow {
  return {
    invoice_id: "inv-1",
    wallet: WALLET,
    is_active: true,
    coverage_bps: 750,
    premium_paid: "12.5000",
    expiry: NOW_SECONDS + 3600,
    purchased_at: NOW_SECONDS - 60,
    ...overrides,
  };
}

/**
 * Serves rows by invoice/wallet from a fixed list, mirroring the two queries
 * in InvoiceInsuranceService. Keeps a call counter for cache assertions.
 */
function makeDataSource(rows: FakePolicyRow[]) {
  const query = jest.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes("FROM insurance_payouts")) return [];
    if (sql.includes("wallet = $1 AND is_active = true")) {
      const wallet = params[0];
      return rows.filter((row) => row.wallet === wallet && row.is_active);
    }
    const [invoiceId, wallet] = params;
    return rows.filter((row) => row.invoice_id === invoiceId && row.wallet === wallet);
  });
  return { query } as unknown as DataSource & { query: jest.Mock };
}

function setup(rows: FakePolicyRow[] = [makeRow()]) {
  let clock = NOW;
  const dataSource = makeDataSource(rows);
  const service = new InvoiceInsuranceService(dataSource, { now: () => clock });
  return {
    service,
    dataSource,
    advanceSeconds(seconds: number) {
      clock = new Date(clock.getTime() + seconds * 1000);
    },
  };
}

describe("isPolicyActiveAt (issue #777)", () => {
  it("uses exclusive expiry seconds as the activity boundary", () => {
    expect(isPolicyActiveAt({ is_active: true, expiry: NOW_SECONDS + 1 }, NOW)).toBe(true);
    expect(isPolicyActiveAt({ is_active: true, expiry: NOW_SECONDS }, NOW)).toBe(false);
    expect(isPolicyActiveAt({ is_active: true, expiry: NOW_SECONDS - 1 }, NOW)).toBe(false);
  });

  it("treats zero, negative, missing and invalid expiry as inactive", () => {
    expect(isPolicyActiveAt({ is_active: true, expiry: 0 }, NOW)).toBe(false);
    expect(isPolicyActiveAt({ is_active: true, expiry: -100 }, NOW)).toBe(false);
    expect(isPolicyActiveAt({ is_active: true, expiry: null }, NOW)).toBe(false);
    expect(
      isPolicyActiveAt({ is_active: true, expiry: "not-a-timestamp" as unknown as number }, NOW),
    ).toBe(false);
  });

  it("respects the stored inactive flag", () => {
    expect(isPolicyActiveAt({ is_active: false, expiry: NOW_SECONDS + 3600 }, NOW)).toBe(false);
  });
});

describe("InvoiceInsuranceService effective expiry (issue #777)", () => {
  it("keeps a valid future policy active with its premium and coverage", async () => {
    const { service } = setup();

    const policy = await service.getInvoiceInsurance("inv-1", WALLET);
    const [active] = await service.getWalletActivePolicies(WALLET);

    expect(policy).toEqual({
      isActive: true,
      coverageBps: 750,
      premiumPaid: "12.5000",
      expiry: NOW_SECONDS + 3600,
    });
    expect(active).toMatchObject({
      invoiceId: "inv-1",
      isActive: true,
      coverageBps: 750,
      premiumPaid: "12.5000",
    });
  });

  it("excludes past-expiry policies from active wallet results", async () => {
    const { service } = setup([makeRow({ expiry: NOW_SECONDS - 1 })]);

    expect(await service.getWalletActivePolicies(WALLET)).toEqual([]);
    const policy = await service.getInvoiceInsurance("inv-1", WALLET);
    expect(policy?.isActive).toBe(false);
  });

  it("marks a single policy inactive at the exact expiry boundary", async () => {
    const { service } = setup([makeRow({ expiry: NOW_SECONDS })]);

    const policy = await service.getInvoiceInsurance("inv-1", WALLET);
    expect(policy?.isActive).toBe(false);
    expect(await service.getWalletActivePolicies(WALLET)).toEqual([]);
  });

  it("recomputes activity inside the cache TTL when the clock crosses expiry", async () => {
    const { service, dataSource, advanceSeconds } = setup([
      makeRow({ expiry: NOW_SECONDS + 30 }),
    ]);

    expect((await service.getInvoiceInsurance("inv-1", WALLET))?.isActive).toBe(true);
    expect(dataSource.query).toHaveBeenCalledTimes(1);

    advanceSeconds(31);
    expect((await service.getInvoiceInsurance("inv-1", WALLET))?.isActive).toBe(false);
    expect(dataSource.query).toHaveBeenCalledTimes(1);
  });

  it("does not serve a cached active policy after expiry passes", async () => {
    const { service, dataSource, advanceSeconds } = setup([
      makeRow({ expiry: NOW_SECONDS + 5 }),
    ]);

    await service.getInvoiceInsurance("inv-1", WALLET);
    await service.getWalletActivePolicies(WALLET);
    expect(dataSource.query).toHaveBeenCalledTimes(2);

    advanceSeconds(6);
    const policy = await service.getInvoiceInsurance("inv-1", WALLET);
    const list = await service.getWalletActivePolicies(WALLET);

    expect(policy?.isActive).toBe(false);
    expect(list).toEqual([]);
    // Both reads were cache hits re-evaluated against the clock.
    expect(dataSource.query).toHaveBeenCalledTimes(2);
  });

  it("keeps unrelated future policies while filtering an expired one", async () => {
    const expired = makeRow({ invoice_id: "inv-expired", expiry: NOW_SECONDS - 10 });
    const future = makeRow({ invoice_id: "inv-future", expiry: NOW_SECONDS + 10_000 });
    const { service, advanceSeconds } = setup([expired, future]);

    // Cache the future policy as active, then let it stay valid while the
    // short-lived one crosses its boundary.
    const first = await service.getWalletActivePolicies(WALLET);
    expect(first.map((p) => p.invoiceId)).toEqual(["inv-future"]);

    advanceSeconds(1);
    const second = await service.getWalletActivePolicies(WALLET);
    expect(second.map((p) => p.invoiceId)).toEqual(["inv-future"]);
  });

  it("refreshes after invalidate so a re-purchase can reactivate a policy", async () => {
    const row = makeRow({ expiry: NOW_SECONDS - 10 });
    const { service, dataSource } = setup([row]);

    expect((await service.getInvoiceInsurance("inv-1", WALLET))?.isActive).toBe(false);

    row.expiry = NOW_SECONDS + 3600;
    await service.invalidate("inv-1", WALLET);

    expect((await service.getInvoiceInsurance("inv-1", WALLET))?.isActive).toBe(true);
    expect(dataSource.query).toHaveBeenCalledTimes(2);
  });
});
