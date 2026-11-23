import Decimal from "decimal.js";

/**
 * Shared percentage calculation path for API responses.
 *
 * Money and other decimal inputs are never converted to JavaScript numbers
 * before the division, so the result does not depend on IEEE-754 rounding.
 * Every percentage exposed by the API must be produced here (or formatted
 * here) so that equivalent inputs yield identical responses across endpoints.
 */

/** Number of decimal places in every percentage returned by the API. */
export const PERCENTAGE_RESPONSE_SCALE = 2;

/** Rounding mode applied at the response scale (half away from zero). */
export const PERCENTAGE_ROUNDING = Decimal.ROUND_HALF_UP;

/** Wire value returned when the principal/denominator is zero. */
export const ZERO_PRINCIPAL_PERCENTAGE = "0.00";

/** Decimal-compatible input. JavaScript `number` is deliberately excluded. */
export type PercentageInput = string | bigint | Decimal;

export interface PercentageOptions {
  /** Upper bound applied before rounding (e.g. 100 for a share of a whole). */
  maximum?: PercentageInput | number;
  /**
   * Explicit zero-principal policy. Defaults to `"zero"`, which returns the
   * documented {@link ZERO_PRINCIPAL_PERCENTAGE} instead of NaN/Infinity.
   */
  onZeroPrincipal?: "zero" | "throw";
}

function toDecimal(value: PercentageInput, label: string): Decimal {
  const decimal =
    value instanceof Decimal
      ? value
      : typeof value === "bigint"
        ? new Decimal(value.toString())
        : new Decimal(value);

  if (!decimal.isFinite()) {
    throw new RangeError(`${label} must be a finite decimal value`);
  }

  return decimal;
}

/**
 * Calculates `(part / whole) * 100` using decimal arithmetic and rounds it to
 * {@link PERCENTAGE_RESPONSE_SCALE} places with {@link PERCENTAGE_ROUNDING}.
 *
 * A zero `whole` is not a division: it returns zero when
 * `onZeroPrincipal` is `"zero"` (the default, matching existing API behavior)
 * and throws a `RangeError` when it is `"throw"`.
 */
export function calculatePercentage(
  part: PercentageInput,
  whole: PercentageInput,
  options: PercentageOptions = {}
): Decimal {
  const numerator = toDecimal(part, "part");
  const denominator = toDecimal(whole, "whole");

  if (denominator.isZero()) {
    if (options.onZeroPrincipal === "throw") {
      throw new RangeError("Cannot calculate a percentage when the principal is zero");
    }
    return new Decimal(0);
  }

  let percentage = numerator.dividedBy(denominator).times(100);

  if (options.maximum !== undefined) {
    const maximum =
      typeof options.maximum === "number"
        ? new Decimal(options.maximum)
        : toDecimal(options.maximum, "maximum");
    percentage = Decimal.min(percentage, maximum);
  }

  return percentage.toDecimalPlaces(PERCENTAGE_RESPONSE_SCALE, PERCENTAGE_ROUNDING);
}

/** Formats an already-calculated percentage at the response scale. */
export function formatPercentage(value: PercentageInput): string {
  return toDecimal(value, "percentage")
    .toDecimalPlaces(PERCENTAGE_RESPONSE_SCALE, PERCENTAGE_ROUNDING)
    .toFixed(PERCENTAGE_RESPONSE_SCALE, PERCENTAGE_ROUNDING);
}

/** Percentage as the canonical API string (e.g. `"33.33"`). */
export function percentageString(
  part: PercentageInput,
  whole: PercentageInput,
  options: PercentageOptions = {}
): string {
  return formatPercentage(calculatePercentage(part, whole, options));
}

/**
 * Percentage as a number for response fields whose contract is numeric.
 * The value is rounded to the response scale first, so no money value is ever
 * handed to the floating-point engine.
 */
export function percentageNumber(
  part: PercentageInput,
  whole: PercentageInput,
  options: PercentageOptions = {}
): number {
  return Number(percentageString(part, whole, options));
}

/** Converts a percentage (e.g. `"5.00"` or `"5.25"`) to integer basis points. */
export function percentageToBasisPoints(rate: PercentageInput): number {
  return toDecimal(rate, "rate")
    .times(100)
    .toDecimalPlaces(0, PERCENTAGE_ROUNDING)
    .toNumber();
}
