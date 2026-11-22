import { claimKey, assertRevision } from "../../src/services/payout-claims.service";
import {
  statementCsv,
  statementTotals,
  RoyaltyStatementRow,
} from "../../src/services/royalty-statements.service";

const row: RoyaltyStatementRow = {
  id: "row",
  cycleId: "cycle",
  cycleAt: null,
  revision: 1,
  keyAddress: "key",
  gross: "9999999999999.9999",
  platformFee: "0.0001",
  net: "9999999999999.9998",
  txHash: null,
  paidAt: null,
};

describe("Payout identity and statement amounts", () => {
  it("separates wallet, cycle, revision and payout kind without concatenation collisions", () => {
    const key = claimKey("royalty", "wallet", "cycle", 1);
    expect(key).toBe(claimKey("royalty", "wallet", "cycle", 1));
    expect(
      new Set([
        key,
        claimKey("dividend", "wallet", "cycle", 1),
        claimKey("royalty", "wallet2", "cycle", 1),
        claimKey("royalty", "wallet", "cycle2", 1),
        claimKey("royalty", "wallet", "cycle", 2),
      ])
    ).toHaveProperty("size", 5);
    expect(claimKey("royalty", "a:b", "c", 1)).not.toBe(claimKey("royalty", "a", "b:c", 1));
  });
  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid revision %s",
    (revision) => {
      expect(() => assertRevision(revision)).toThrow("Revision must be a positive integer");
    }
  );
  it("reconciles decimal totals without passing through floating point", () => {
    expect(
      statementTotals([row, { ...row, gross: "0.0001", platformFee: "0.0000", net: "0.0001" }])
    ).toEqual({
      gross: "10000000000000.0000",
      platformFee: "0.0001",
      net: "9999999999999.9999",
    });
    expect(statementTotals([])).toEqual({ gross: "0.0000", platformFee: "0.0000", net: "0.0000" });
  });
  it("quotes commas, quotes and newlines and neutralizes formula prefixes in CSV", () => {
    const csv = statementCsv([
      { ...row, keyAddress: 'key,"quoted"\nnext', cycleId: '=HYPERLINK("url")' },
    ]);
    expect(csv).toContain('"key,""quoted""\nnext"');
    expect(csv).toContain('"\'=HYPERLINK(""url"")"');
    expect(csv).toContain('"9999999999999.9998"');
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});
