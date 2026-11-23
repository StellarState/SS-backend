import Decimal from "decimal.js";
import {
  calculatePercentage,
  formatPercentage,
  percentageNumber,
  percentageString,
  percentageToBasisPoints,
  PERCENTAGE_RESPONSE_SCALE,
  ZERO_PRINCIPAL_PERCENTAGE,
} from "../../../src/utils/percentage.utils";

describe("percentage.utils", () => {
  const reference = (part: string, whole: string): string =>
    new Decimal(part)
      .dividedBy(new Decimal(whole))
      .times(100)
      .toDecimalPlaces(PERCENTAGE_RESPONSE_SCALE, Decimal.ROUND_HALF_UP)
      .toFixed(PERCENTAGE_RESPONSE_SCALE);

  it("produces identical percentages for equivalent decimals and integer ratios", () => {
    expect(percentageString("1", "3")).toBe("33.33");
    expect(percentageString("100000000000000000000", "300000000000000000000")).toBe("33.33");
    expect(percentageString(new Decimal("0.01"), new Decimal("0.03"))).toBe("33.33");
    expect(percentageString(1n, 3n)).toBe("33.33");
  });

  it("rounds half up at the response scale", () => {
    // 1/32 = 3.125% -> 3.13 at two decimal places.
    expect(percentageString("1", "32")).toBe("3.13");
    expect(percentageString("1", "6")).toBe("16.67");
    expect(percentageString("2", "3")).toBe("66.67");
  });

  it("keeps decimal precision for values beyond Number.MAX_SAFE_INTEGER", () => {
    const part = "123456789012345678901234567890.12345678";
    const whole = "987654321098765432109876543210.87654321";

    expect(percentageString(part, whole)).toBe(reference(part, whole));
    expect(percentageString(part, whole)).not.toBe("0.00");
  });

  it("makes zero-principal behavior explicit", () => {
    expect(percentageString("100", "0")).toBe(ZERO_PRINCIPAL_PERCENTAGE);
    expect(percentageNumber("100", "0")).toBe(0);
    expect(calculatePercentage("100", "0").isZero()).toBe(true);
    expect(() => percentageString("100", "0", { onZeroPrincipal: "throw" })).toThrow(RangeError);
  });

  it("applies a maximum before rounding", () => {
    expect(percentageString("150", "100", { maximum: 100 })).toBe("100.00");
    expect(percentageString("99.999", "100", { maximum: 100 })).toBe("100.00");
  });

  it("formats already-calculated percentages at the response scale", () => {
    expect(formatPercentage(new Decimal("12.345"))).toBe("12.35");
    expect(formatPercentage("7")).toBe("7.00");
    expect(PERCENTAGE_RESPONSE_SCALE).toBe(2);
  });

  it("converts percentages to integer basis points without float arithmetic", () => {
    expect(percentageToBasisPoints("5.00")).toBe(500);
    expect(percentageToBasisPoints("5.125")).toBe(513);
    expect(percentageToBasisPoints(new Decimal("2.5"))).toBe(250);
  });

  it("matches decimal reference for large pseudo-random values (property test)", () => {
    // Deterministic xorshift so failures are reproducible.
    let state = 0x9e3779b9n;
    const next = (): bigint => {
      state ^= (state << 13n) & 0xffffffffn;
      state ^= state >> 17n;
      state ^= (state << 5n) & 0xffffffffn;
      return state;
    };

    for (let i = 0; i < 500; i++) {
      const whole = next() * next() + 1n;
      const part = next() * next() % whole;

      const actual = percentageString(part, whole);
      expect(actual).toBe(reference(part.toString(), whole.toString()));

      const actualNumber = percentageNumber(part, whole);
      expect(Number.isFinite(actualNumber)).toBe(true);
      expect(actualNumber).toBeGreaterThanOrEqual(0);
      expect(actualNumber).toBeLessThanOrEqual(100);
    }
  });
});
