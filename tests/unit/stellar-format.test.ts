import { stroopsToXlm } from "@/lib/stellar-format";

describe("stroopsToXlm", () => {
  it("converts 10000000 stroops to 1.0000000", () => {
    expect(stroopsToXlm(10_000_000n)).toBe("1.0000000");
  });

  it("converts 1 stroop to 0.0000001", () => {
    expect(stroopsToXlm(1n)).toBe("0.0000001");
  });

  it("converts 0 stroops to 0.0000000", () => {
    expect(stroopsToXlm(0n)).toBe("0.0000000");
  });

  it("converts a large value above MAX_SAFE_INTEGER without floating point error", () => {
    // Number.MAX_SAFE_INTEGER (9007199254740991) whole XLM, in stroops.
    const stroops = 9_007_199_254_740_991n * 10_000_000n;
    expect(stroopsToXlm(stroops)).toBe("9007199254740991.0000000");
  });

  it("converts 1000000000000 stroops without precision loss", () => {
    expect(stroopsToXlm(1_000_000_000_000n)).toBe("100000.0000000");
  });

  it("supports a decimal override", () => {
    expect(stroopsToXlm(12_345_678n, 2)).toBe("1.23");
  });

  it("truncates rather than rounds when overriding to fewer decimals", () => {
    expect(stroopsToXlm(19_999_999n, 0)).toBe("1");
  });

  it("pads with zeros when overriding to more decimals than stroop precision", () => {
    expect(stroopsToXlm(10_000_000n, 9)).toBe("1.000000000");
  });

  it("handles negative amounts", () => {
    expect(stroopsToXlm(-10_000_000n)).toBe("-1.0000000");
  });
});
