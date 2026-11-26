import { Decimal } from "decimal.js";
import { transferHoldings } from "../../src/services/secondary-market.service";
import {
  isPastSecondaryTradingCutoff,
  secondaryTradingCutoff,
  startOfDayUTC,
} from "../../src/utils/date.utils";

const h = (investmentAmount: string, expectedReturn: string) => ({
  investmentAmount,
  expectedReturn,
});
const sum = (values: string[]) => values.reduce((s, v) => s.plus(v), new Decimal(0)).toFixed(4);

describe("transferHoldings (#749, #750)", () => {
  it("moves principal and the proportional entitlement on a partial fill", () => {
    const result = transferHoldings([h("1000.0000", "1050.0000")], new Decimal("250"));
    expect(result.holdings).toEqual([h("750.0000", "787.5000")]);
    expect(result.principal.toFixed(4)).toBe("250.0000");
    expect(result.expectedReturn.toFixed(4)).toBe("262.5000");
  });

  it("moves all remaining entitlement when a holding is emptied", () => {
    const result = transferHoldings([h("1.0000", "1.0334")], new Decimal("1"));
    expect(result.holdings).toEqual([h("0.0000", "0.0000")]);
    expect(result.expectedReturn.toFixed(4)).toBe("1.0334");
  });

  it("rounds the moved entitlement down so it is never created", () => {
    const result = transferHoldings([h("3.0000", "3.1000")], new Decimal("1"));
    expect(result.expectedReturn.toFixed(4)).toBe("1.0333");
    expect(result.holdings[0].expectedReturn).toBe("2.0667");
  });

  it("conserves entitlement across many repeated fills", () => {
    let holdings = [h("7.0000", "7.7777")];
    const moved: string[] = [];
    for (let i = 0; i < 7; i++) {
      const result = transferHoldings(holdings, new Decimal("1"));
      holdings = result.holdings;
      moved.push(result.expectedReturn.toFixed(4));
    }
    expect(holdings).toEqual([h("0.0000", "0.0000")]);
    expect(sum(moved)).toBe("7.7777");
  });

  it("is independent of trade price: only principal and its entitlement move", () => {
    // A loss-making position (expected < principal) keeps the same basis.
    const result = transferHoldings([h("100.0000", "80.0000")], new Decimal("25"));
    expect(result.expectedReturn.toFixed(4)).toBe("20.0000");
  });

  it("consumes holdings in order and leaves untouched rows unchanged", () => {
    const result = transferHoldings(
      [h("30.0000", "31.5000"), h("50.0000", "52.5000"), h("10.0000", "10.5000")],
      new Decimal("40")
    );
    expect(result.holdings).toEqual([
      h("0.0000", "0.0000"),
      h("40.0000", "42.0000"),
      h("10.0000", "10.5000"),
    ]);
    expect(result.expectedReturn.toFixed(4)).toBe("42.0000");
  });

  it("skips holdings with no positive principal", () => {
    const result = transferHoldings(
      [h("0.0000", "5.0000"), h("-10.0000", "0.0000"), h("20.0000", "21.0000")],
      new Decimal("20")
    );
    expect(result.holdings).toEqual([
      h("0.0000", "5.0000"),
      h("-10.0000", "0.0000"),
      h("0.0000", "0.0000"),
    ]);
  });

  it("refuses an unbacked fill: 100 units cannot be filled from 60", () => {
    expect(() =>
      transferHoldings([h("40.0000", "42.0000"), h("20.0000", "21.0000")], new Decimal("100"))
    ).toThrow(
      expect.objectContaining({
        code: "UNBACKED_FILL",
        statusCode: 409,
        details: { requested: "100.0000", backed: "60.0000" },
      })
    );
  });

  it("does not let negative drift back a fill", () => {
    expect(() =>
      transferHoldings([h("-50.0000", "0.0000"), h("100.0000", "100.0000")], new Decimal("150"))
    ).toThrow(expect.objectContaining({ code: "UNBACKED_FILL" }));
  });
});

describe("secondary trading cutoff (#747)", () => {
  it("is the start of the due day in UTC, for date strings and Dates", () => {
    expect(startOfDayUTC("2030-06-15").toISOString()).toBe("2030-06-15T00:00:00.000Z");
    expect(startOfDayUTC(new Date("2030-06-15T18:30:00Z")).toISOString()).toBe(
      "2030-06-15T00:00:00.000Z"
    );
    expect(secondaryTradingCutoff("2030-06-15").toISOString()).toBe("2030-06-15T00:00:00.000Z");
  });

  it("closes trading exactly at the cutoff", () => {
    const cutoff = new Date("2030-06-15T00:00:00.000Z");
    expect(isPastSecondaryTradingCutoff("2030-06-15", new Date(cutoff.getTime() - 1))).toBe(false);
    expect(isPastSecondaryTradingCutoff("2030-06-15", cutoff)).toBe(true);
  });

  it("treats a missing due date as never maturing", () => {
    expect(isPastSecondaryTradingCutoff(null, new Date())).toBe(false);
  });
});
