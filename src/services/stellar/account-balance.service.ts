import { Decimal } from "decimal.js";

export interface AccountBalanceChecker {
  getBalance(stellarAddress: string): Promise<Decimal>;
}

/**
 * Fetches the XLM balance for a Stellar account via the Horizon HTTP API.
 * Used by the auto-invest rule engine to gate investments on minimum wallet balance.
 */
export class HorizonAccountBalanceService implements AccountBalanceChecker {
  constructor(private readonly horizonUrl: string) {}

  async getBalance(stellarAddress: string): Promise<Decimal> {
    const url = `${this.horizonUrl.replace(/\/$/, "")}/accounts/${encodeURIComponent(stellarAddress)}`;
    const response = await fetch(url);
    if (response.status === 404) {
      return new Decimal(0);
    }
    if (!response.ok) {
      throw new Error(`Horizon account lookup failed: ${response.status}`);
    }
    const data = (await response.json()) as { balances: Array<{ asset_type: string; balance: string }> };
    const native = data.balances.find((b) => b.asset_type === "native");
    return native ? new Decimal(native.balance) : new Decimal(0);
  }
}
