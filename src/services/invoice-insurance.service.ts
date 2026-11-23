import { DataSource } from "typeorm";
import { TtlCache } from "../lib/ttl-cache";

export interface InsurancePolicy {
  invoiceId: string;
  wallet: string;
  isActive: boolean;
  coverageBps: number;
  premiumPaid: string;
  expiry: number;
  purchasedAt: number;
}

export interface InsurancePayout {
  invoiceId: string;
  wallet: string;
  amount: string;
  triggerDate: number;
  txHash: string;
}

export interface InvoiceInsuranceResponse {
  isActive: boolean;
  coverageBps: number;
  premiumPaid: string;
  expiry: number;
}

export const INSURANCE_CACHE_TTL_SECONDS = 60;

export interface InvoiceInsuranceServiceOptions {
  /** Injectable clock used to evaluate effective policy activity. */
  now?: () => Date;
  cacheTtlSeconds?: number;
}

interface InvoiceInsuranceRow {
  is_active: boolean;
  coverage_bps: number;
  premium_paid: string;
  expiry: number;
}

interface InsurancePolicyRow extends InvoiceInsuranceRow {
  invoice_id: string;
  wallet: string;
  purchased_at: number;
}

interface InsurancePayoutRow {
  invoice_id: string;
  wallet: string;
  amount: string;
  trigger_date: number;
  tx_hash: string;
}

/**
 * Effective activity rule for an indexed policy (issue #777).
 *
 * `expiry` is an absolute Unix timestamp in **seconds** (the `expiry` column is
 * a BIGINT written by the insurance indexer). A policy is active only while its
 * stored `is_active` flag is true **and** the current time is strictly before
 * `expiry`, so the boundary itself counts as expired.
 *
 * Zero, negative, missing and non-numeric expiry values are treated as already
 * expired: without a usable deadline the service cannot promise coverage, and
 * reporting it as active would grant access that may not exist on chain.
 */
export function isPolicyActiveAt(
  policy: { is_active: boolean | number | string | null; expiry: number | string | null },
  now: Date
): boolean {
  if (!policy.is_active) return false;
  const expiry = typeof policy.expiry === "number" ? policy.expiry : Number(policy.expiry);
  if (!Number.isFinite(expiry) || expiry <= 0) return false;
  return now.getTime() / 1000 < expiry;
}

/**
 * #680 — Invoice insurance indexer and policy status REST API.
 * Indexes InsurancePurchased and InsurancePayoutTriggered events.
 *
 * Views are cached for {@link INSURANCE_CACHE_TTL_SECONDS}, but activity is
 * time-dependent: every read (cache hit included) re-evaluates the expiry
 * boundary instead of trusting the flag computed when the value was cached.
 */
export class InvoiceInsuranceService {
  private cache: TtlCache;
  private readonly now: () => Date;

  constructor(
    private readonly dataSource: DataSource,
    options: InvoiceInsuranceServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.cache = new TtlCache({
      ttlSeconds: options.cacheTtlSeconds ?? INSURANCE_CACHE_TTL_SECONDS,
      namespace: "insurance",
    });
  }

  async getInvoiceInsurance(
    invoiceId: string,
    wallet: string
  ): Promise<InvoiceInsuranceResponse | null> {
    const cacheKey = `invoice:${invoiceId}:${wallet}`;
    const cached = await this.cache.get<InvoiceInsuranceResponse>(cacheKey);
    if (cached) {
      return { ...cached, isActive: isPolicyActiveAt(toActivityInput(cached), this.now()) };
    }

    const row = (await this.dataSource.query(
      `SELECT is_active, coverage_bps, premium_paid, expiry
       FROM invoice_insurance WHERE invoice_id = $1 AND wallet = $2`,
      [invoiceId, wallet],
    )) as InvoiceInsuranceRow[];

    if (!row.length) return null;

    const result = {
      isActive: isPolicyActiveAt(row[0], this.now()),
      coverageBps: row[0].coverage_bps,
      premiumPaid: row[0].premium_paid,
      expiry: row[0].expiry,
    };

    await this.cache.set(cacheKey, result);
    return result;
  }

  async getWalletActivePolicies(wallet: string): Promise<InsurancePolicy[]> {
    const cacheKey = `wallet:${wallet}`;
    const cached = await this.cache.get<InsurancePolicy[]>(cacheKey);
    if (cached) {
      const now = this.now();
      return cached.filter((policy) => isPolicyActiveAt(toActivityInput(policy), now));
    }

    const rows = (await this.dataSource.query(
      `SELECT invoice_id, wallet, is_active, coverage_bps, premium_paid, expiry, purchased_at
       FROM invoice_insurance WHERE wallet = $1 AND is_active = true`,
      [wallet],
    )) as InsurancePolicyRow[];

    const now = this.now();
    const policies = rows
      .filter((row) => isPolicyActiveAt(row, now))
      .map((row) => ({
        invoiceId: row.invoice_id,
        wallet: row.wallet,
        isActive: true,
        coverageBps: row.coverage_bps,
        premiumPaid: row.premium_paid,
        expiry: row.expiry,
        purchasedAt: row.purchased_at,
      }));

    await this.cache.set(cacheKey, policies);
    return policies;
  }

  async getWalletPayoutHistory(wallet: string): Promise<InsurancePayout[]> {
    const cacheKey = `payouts:${wallet}`;
    const cached = await this.cache.get<InsurancePayout[]>(cacheKey);
    if (cached) return cached;

    const rows = (await this.dataSource.query(
      `SELECT invoice_id, wallet, amount, trigger_date, tx_hash
       FROM insurance_payouts WHERE wallet = $1 ORDER BY trigger_date DESC`,
      [wallet],
    )) as InsurancePayoutRow[];

    const payouts = rows.map((row) => ({
      invoiceId: row.invoice_id,
      wallet: row.wallet,
      amount: row.amount,
      triggerDate: row.trigger_date,
      txHash: row.tx_hash,
    }));

    await this.cache.set(cacheKey, payouts);
    return payouts;
  }

  /** Invalidate cache for a wallet/invoice pair when an insurance event occurs. */
  async invalidate(invoiceId: string, wallet: string): Promise<void> {
    await Promise.all([
      this.cache.delete(`invoice:${invoiceId}:${wallet}`),
      this.cache.delete(`wallet:${wallet}`),
      this.cache.delete(`payouts:${wallet}`),
    ]);
  }
}

/** Adapts a public view to the fields the activity rule needs. */
function toActivityInput(view: { isActive: boolean; expiry: number }): {
  is_active: boolean;
  expiry: number;
} {
  return { is_active: view.isActive, expiry: view.expiry };
}

export function createInvoiceInsuranceService(
  dataSource: DataSource,
  options: InvoiceInsuranceServiceOptions = {}
): InvoiceInsuranceService {
  return new InvoiceInsuranceService(dataSource, options);
}
