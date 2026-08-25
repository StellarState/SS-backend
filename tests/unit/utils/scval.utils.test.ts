import { scValToNative } from "stellar-sdk";
import { scValI128, scValU64 } from "../../../../src/services/stellar/utils/scval.utils";

describe("scValI128", () => {
  it("should encode zero correctly", () => {
    const val = scValI128(0n);
    expect(scValToNative(val)).toBe(0n);
  });

  it("should encode a positive bigint", () => {
    const val = scValI128(500_000_000n);
    expect(scValToNative(val)).toBe(500_000_000n);
  });

  it("should encode a large i128 stroop value", () => {
    const large = BigInt("115792089237316195423570985008687907853269984665640564039457584007913129639935");
    const val = scValI128(large);
    expect(scValToNative(val)).toBe(large);
  });

  it("should encode from string input", () => {
    const val = scValI128("1000000000");
    expect(scValToNative(val)).toBe(1000000000n);
  });

  it("should encode negative values", () => {
    const val = scValI128(-500n);
    expect(scValToNative(val)).toBe(-500n);
  });
});

describe("scValU64", () => {
  it("should encode zero correctly", () => {
    const val = scValU64(0);
    expect(scValToNative(val)).toBe(0n);
  });

  it("should encode a timestamp", () => {
    const val = scValU64(1770000000);
    expect(scValToNative(val)).toBe(1770000000n);
  });

  it("should encode max u64", () => {
    const maxU64 = 18446744073709551615;
    const val = scValU64(maxU64);
    expect(scValToNative(val)).toBe(18446744073709551615n);
  });
});
