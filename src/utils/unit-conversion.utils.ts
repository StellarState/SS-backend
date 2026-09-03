import Decimal from "decimal.js";

const STROOPS_PER_XLM = 10_000_000;
const STROOP_DIVISOR = new Decimal(STROOPS_PER_XLM);

export { stroopsToXlm } from "../lib/stellar-format";

/**
 * Converts a human-readable XLM/USDC decimal amount to stroops (1 XLM = 10,000,000 stroops),
 * using Decimal.js for precise arithmetic before converting to bigint.
 *
 * @param xlm - Amount in XLM/USDC (as string or number)
 * @returns The equivalent amount in stroops as a bigint
 *
 * @example
 * xlmToStroops("1.0000000")   // 10_000_000n
 * xlmToStroops("0.0000001")   // 1n
 * xlmToStroops("0")           // 0n
 * xlmToStroops(1)             // 10_000_000n
 */
export function xlmToStroops(xlm: string | number): bigint {
  const dec = new Decimal(xlm);
  if (dec.isNaN()) {
    throw new TypeError(`Invalid XLM amount: ${xlm}`);
  }
  return BigInt(dec.times(STROOP_DIVISOR).toFixed(0, Decimal.ROUND_DOWN));
}
