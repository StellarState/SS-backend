import Decimal from "decimal.js";

const STROOP_DECIMALS = 7;
const STROOPS_PER_XLM = 10_000_000;
const STROOP_DIVISOR = new Decimal(STROOPS_PER_XLM);

/**
 * Converts an amount in stroops (1 XLM = 10,000,000 stroops) to a human-readable
 * XLM/USDC decimal string, using Decimal.js for precise arithmetic.
 *
 * @param stroops - Amount in stroops (as bigint or string representation of a bigint)
 * @returns A decimal string with 7 decimal places of stroop precision
 *
 * @example
 * stroopsToXlm(10_000_000n)   // "1.0000000"
 * stroopsToXlm(1n)            // "0.0000001"
 * stroopsToXlm(0n)            // "0.0000000"
 * stroopsToXlm("10000000")    // "1.0000000"
 */
export function stroopsToXlm(stroops: bigint | string): string {
    return new Decimal(stroops.toString()).dividedBy(STROOP_DIVISOR).toFixed(STROOP_DECIMALS);
}

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
    return BigInt(new Decimal(xlm).times(STROOP_DIVISOR).toFixed(0, Decimal.ROUND_DOWN));
}
