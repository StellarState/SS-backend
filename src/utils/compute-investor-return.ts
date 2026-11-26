import { computeInvestorReturn as computeScaledInvestorReturn } from "../lib/investor-return";

/**
 * Validates stroop-denominated inputs for the settlement flow and delegates
 * the arithmetic to the single canonical implementation in
 * `src/lib/investor-return.ts`, so every caller shares one calculation path.
 */
export function computeInvestorReturn(
  investorFundedStroops: bigint,
  totalFundedStroops: bigint,
  settledProceedsStroops: bigint
): bigint {
  if (totalFundedStroops === 0n) {
    throw new Error("Total funded amount cannot be zero");
  }

  if (investorFundedStroops < 0n || totalFundedStroops < 0n || settledProceedsStroops < 0n) {
    throw new Error("All amounts must be non-negative");
  }

  if (investorFundedStroops > totalFundedStroops) {
    throw new Error("Investor funded amount cannot exceed total funded amount");
  }

  return computeScaledInvestorReturn(
    investorFundedStroops,
    totalFundedStroops,
    settledProceedsStroops
  );
}
