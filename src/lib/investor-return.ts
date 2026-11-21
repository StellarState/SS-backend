/**
 * Computes an investor's pro-rata share of settled proceeds using pure
 * integer arithmetic. Division truncates toward zero, which for
 * non-negative bigint operands is equivalent to flooring — the investor
 * never receives more than their exact proportional share.
 */
export function computeInvestorReturn(
  investedAmount: bigint,
  totalFunded: bigint,
  settledProceeds: bigint
): bigint {
  if (totalFunded <= 0n) {
    throw new RangeError("totalFunded must be greater than zero");
  }
  if (investedAmount < 0n) {
    throw new RangeError("investedAmount must not be negative");
  }
  if (settledProceeds < 0n) {
    throw new RangeError("settledProceeds must not be negative");
  }

  return (investedAmount * settledProceeds) / totalFunded;
}

/**
 * The fractional-remainder numerator for an investor's pro-rata share:
 * `(investedAmount * settledProceeds) % totalFunded`.
 *
 * Every investor shares the same denominator (`totalFunded`), so comparing
 * these numerators ranks investors by their exact fractional entitlement
 * without floating point. Used by the largest-remainder allocation in
 * `allocateSettlementProceeds` (#841).
 */
export function computeInvestorRemainderNumerator(
  investedAmount: bigint,
  totalFunded: bigint,
  settledProceeds: bigint
): bigint {
  if (totalFunded <= 0n) {
    throw new RangeError("totalFunded must be greater than zero");
  }
  if (investedAmount < 0n) {
    throw new RangeError("investedAmount must not be negative");
  }
  if (settledProceeds < 0n) {
    throw new RangeError("settledProceeds must not be negative");
  }

  return (investedAmount * settledProceeds) % totalFunded;
}

/**
 * Result of allocating a single investor's share of settled proceeds.
 */
export interface InvestorProRataAllocation {
  readonly investmentId: string;
  readonly investorId: string;
  /** Floor division result (base share before any remainder top-up). */
  readonly baseReturnScaled: bigint;
  /** Remainder top-up assigned to this investor (0n or 1n at the working scale). */
  readonly remainderShareScaled: bigint;
  /** Final allocated amount: `baseReturnScaled + remainderShareScaled`. */
  readonly returnAmountScaled: bigint;
}

/**
 * Allocates `totalScaled` among `investments` using the deterministic
 * largest-remainder (Hamilton) method so that the allocations always sum
 * exactly to `totalScaled` — no rounding dust is lost and no recipient is
 * favoured inconsistently (#841).
 *
 * Every investor receives `floor(investmentAmount * totalScaled / totalFundedScaled)`.
 * The leftover (`totalScaled - sum of floors`, always less than the investor
 * count) is distributed one unit at a time to the investors with the largest
 * fractional remainders. Ties are broken by `investmentId` in ascending order
 * for full determinism.
 *
 * @returns the per-investor allocations. `unallocatedRemainderScaled` is always
 *   `0n` because every unit of `totalScaled` is assigned.
 */
export function allocateSettlementProceeds(
  investments: readonly Array<{
    readonly investmentId: string;
    readonly investorId: string;
    readonly investmentAmountScaled: bigint;
  }>,
  totalScaled: bigint,
  totalFundedScaled: bigint
): {
  readonly allocations: readonly InvestorProRataAllocation[];
  /** Always `0n`: every unit of `totalScaled` is allocated to an investor. */
  readonly unallocatedRemainderScaled: bigint;
} {
  if (totalFundedScaled <= 0n) {
    throw new RangeError("totalFundedScaled must be greater than zero");
  }
  if (totalScaled < 0n) {
    throw new RangeError("totalScaled must not be negative");
  }

  const count = investments.length;
  if (count === 0) {
    return { allocations: [], unallocatedRemainderScaled: totalScaled };
  }

  // Compute the floor (base) share and fractional-remainder numerator for each investor.
  const entries = investments.map((inv) => {
    const base = (inv.investmentAmountScaled * totalScaled) / totalFundedScaled;
    const fractionNumerator = (inv.investmentAmountScaled * totalScaled) % totalFundedScaled;
    return {
      investmentId: inv.investmentId,
      investorId: inv.investorId,
      baseReturnScaled: base,
      fractionNumerator,
    };
  });

  let sumOfBases = 0n;
  for (const entry of entries) {
    sumOfBases += entry.baseReturnScaled;
  }

  // Leftover units to hand out (each investor receives at most +1).
  let leftover = totalScaled - sumOfBases;

  // Rank by fractional remainder descending, then investmentId ascending for determinism.
  const ranked = [...entries].sort((a, b) => {
    if (b.fractionNumerator !== a.fractionNumerator) {
      return b.fractionNumerator > a.fractionNumerator ? 1 : -1;
    }
    return a.investmentId.localeCompare(b.investmentId);
  });

  const shareSet = new Set<string>();
  let i = 0n;
  while (i < leftover && i < BigInt(count)) {
    shareSet.add(ranked[Number(i)].investmentId);
    i += 1n;
  }

  const allocations: InvestorProRataAllocation[] = entries.map((entry) => {
    const share = shareSet.has(entry.investmentId) ? 1n : 0n;
    return {
      investmentId: entry.investmentId,
      investorId: entry.investorId,
      baseReturnScaled: entry.baseReturnScaled,
      remainderShareScaled: share,
      returnAmountScaled: entry.baseReturnScaled + share,
    };
  });

  // Sort by investmentId so the returned array is fully deterministic regardless of input order.
  allocations.sort((left, right) => left.investmentId.localeCompare(right.investmentId));

  return { allocations, unallocatedRemainderScaled: 0n };
}

/**
 * Verifies that `allocations` fully reconcile to `total`: every allocation is
 * non-negative and their `returnAmountScaled` values sum exactly to `total`.
 * Used by audit output to prove no rounding dust was dropped (#841).
 */
export function reconcileProRataAllocations(
  total: bigint,
  allocations: readonly InvestorProRataAllocation[]
): boolean {
  if (total < 0n) return false;
  let sum = 0n;
  for (const allocation of allocations) {
    if (allocation.returnAmountScaled < 0n) return false;
    sum += allocation.returnAmountScaled;
  }
  return sum === total;
}
