import {
  SETTLEMENT_CSV_COLUMNS,
  SETTLEMENT_HISTORY_DEFAULT_LIMIT,
  computeSettlementRecord,
  decodeSettlementCursor,
  encodeSettlementCursor,
  parseSettlementFilters,
  parseSettlementLimit,
  settlementsToCsv,
} from "../../src/services/investor-settlement-history.service";

const row = (overrides: Record<string, string | null> = {}) => ({
  return_id: "6f1c9a52-8a0e-4d3c-9b0a-0c7c1f3e2a11",
  invoice_id: "0b8e2f41-3c5d-4e6f-8a9b-1c2d3e4f5a6b",
  invoice_number: "INV-1",
  invoice_type: "logistics",
  settled_at_exact: "2026-11-20T10:00:00.123456Z",
  invested_amount: "250.0000",
  // Invoice: 1000 invested in total, proceeds 1100, 2% fee = 22,
  // distributable 1078. This holder has 25%: payout floor(1078/4) = 269.5.
  payout_amount: "269.5000",
  total_invested: "1000.0000",
  total_settlement_amount: "1100.0000",
  total_distributed_amount: "1078.0000",
  remainder_amount: "0.0000",
  ...overrides,
});

describe("settlement record arithmetic (issue #782)", () => {
  it("splits a profitable settlement into principal, yield and the pro-rata fee", () => {
    expect(computeSettlementRecord(row())).toEqual({
      invoice_id: "0b8e2f41-3c5d-4e6f-8a9b-1c2d3e4f5a6b",
      invoice_number: "INV-1",
      invoice_type: "logistics",
      settled_at: "2026-11-20T10:00:00.123Z",
      fractions_held: "0.250000",
      invested_amount: "250.0000",
      payout_amount: "269.5000",
      principal_returned: "250.0000",
      yield_earned: "25.0000", // gross share 275 - 250
      fees: "5.5000", // 25% of the 22 fee
      fee_data_available: true,
      net_return_usd: "19.5000",
      net_return_pct: "7.8000", // 19.5 / 250 * 100
    });
  });

  it("reports a loss as negative net return with partial principal and no yield", () => {
    // Proceeds 800 on 1000 invested, 2% fee 16, distributable 784.
    const record = computeSettlementRecord(
      row({
        payout_amount: "196.0000",
        total_settlement_amount: "800.0000",
        total_distributed_amount: "784.0000",
      })
    );
    expect(record).toMatchObject({
      principal_returned: "200.0000",
      yield_earned: "0.0000",
      fees: "4.0000",
      net_return_usd: "-54.0000",
      net_return_pct: "-21.6000",
    });
  });

  it("floors the fee share exactly like the payout, and excludes the rounding remainder from fees", () => {
    // 3 equal holders of 100; proceeds 100.0001, fee 0, distributable 100.0001.
    // Each gets floor(33.33336...) = 33.3333; remainder 0.0002 is dust, not a fee.
    const record = computeSettlementRecord(
      row({
        invested_amount: "100.0000",
        total_invested: "300.0000",
        payout_amount: "33.3333",
        total_settlement_amount: "100.0001",
        total_distributed_amount: "99.9999",
        remainder_amount: "0.0002",
      })
    );
    expect(record.fees).toBe("0.0000");
    expect(record.fractions_held).toBe("0.333333");
    expect(record.net_return_usd).toBe("-66.6667");
    expect(record.net_return_pct).toBe("-66.6667");
  });

  it("marks settlements without remainder data and treats their fee as zero", () => {
    const record = computeSettlementRecord(
      row({ total_settlement_amount: null, total_distributed_amount: null, remainder_amount: null })
    );
    expect(record).toMatchObject({
      fee_data_available: false,
      fees: "0.0000",
      principal_returned: "250.0000",
      yield_earned: "19.5000",
      net_return_usd: "19.5000",
    });
  });

  it("rounds net_return_pct to 4 decimals", () => {
    // 1/3 of a unit gain on 3: 33.3333...%
    const record = computeSettlementRecord(
      row({
        invested_amount: "3.0000",
        total_invested: "3.0000",
        payout_amount: "4.0000",
        total_settlement_amount: "4.0000",
        total_distributed_amount: "4.0000",
      })
    );
    expect(record.net_return_pct).toBe("33.3333");
  });
});

describe("settlement query parameters", () => {
  it("uses whole UTC days for bare dates: from the day's start to the next day's start", () => {
    expect(parseSettlementFilters({ from_date: "2026-11-01", to_date: "2026-11-30" })).toEqual({
      from: "2026-11-01T00:00:00Z",
      before: "2026-12-01T00:00:00.000Z",
    });
    expect(parseSettlementFilters({ to_date: "2026-12-31" }).before).toBe(
      "2027-01-01T00:00:00.000Z"
    );
  });

  it("passes timestamps through as text so microseconds and offsets survive", () => {
    expect(parseSettlementFilters({ from_date: "2026-11-01T09:00:00.123456+01:00" })).toEqual({
      from: "2026-11-01T09:00:00.123456+01:00",
    });
    expect(parseSettlementFilters({ to_date: "2026-11-01T09:00:00Z" })).toEqual({
      to: "2026-11-01T09:00:00Z",
    });
  });

  it("allows from_date = to_date for a single day", () => {
    expect(() =>
      parseSettlementFilters({ from_date: "2026-11-20", to_date: "2026-11-20" })
    ).not.toThrow();
  });

  it.each([
    [{ from_date: "yesterday" }, "INVALID_DATE"],
    [{ to_date: "2026-13-45" }, "INVALID_DATE"],
    [{ to_date: "2026-02-30" }, "INVALID_DATE"],
    [{ from_date: "2026-11-01T09:00:00" }, "INVALID_DATE"],
    [{ from_date: "1700000000" }, "INVALID_DATE"],
    [{ from_date: "2026-12-01", to_date: "2026-11-01" }, "INVALID_DATE_RANGE"],
    [{ invoice_type: "x".repeat(65) }, "INVALID_INVOICE_TYPE"],
  ])("rejects %p with 400 %s", (query, code) => {
    expect(() => parseSettlementFilters(query)).toThrow(
      expect.objectContaining({ code, statusCode: 400 })
    );
  });

  it.each([
    [undefined, SETTLEMENT_HISTORY_DEFAULT_LIMIT],
    ["1", 1],
    ["100", 100],
  ])("parses limit %p as %p", (raw, expected) => {
    expect(parseSettlementLimit(raw)).toBe(expected);
  });

  it.each(["0", "101", "-5", "1.5", "x"])("rejects limit %p", (raw) => {
    expect(() => parseSettlementLimit(raw)).toThrow(
      expect.objectContaining({ code: "INVALID_LIMIT" })
    );
  });

  it("round-trips the cursor and rejects tampered ones", () => {
    const cursor = {
      settledAt: "2026-11-20T10:00:00.123456Z",
      id: "6f1c9a52-8a0e-4d3c-9b0a-0c7c1f3e2a11",
    };
    expect(decodeSettlementCursor(encodeSettlementCursor(cursor))).toEqual(cursor);
    expect(() => decodeSettlementCursor("abc")).toThrow(
      expect.objectContaining({ code: "INVALID_CURSOR" })
    );
    expect(() =>
      decodeSettlementCursor(
        Buffer.from(JSON.stringify({ v: 1, t: "2026-11-20T10:00:00Z", id: cursor.id })).toString(
          "base64url"
        )
      )
    ).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
  });
});

describe("settlement CSV", () => {
  it("has a header with every field and one CRLF-terminated line per record", () => {
    const csv = settlementsToCsv([computeSettlementRecord(row())]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(SETTLEMENT_CSV_COLUMNS.join(","));
    expect(lines[1]).toBe(
      "0b8e2f41-3c5d-4e6f-8a9b-1c2d3e4f5a6b,INV-1,logistics,2026-11-20T10:00:00.123Z,0.250000,250.0000,269.5000,250.0000,25.0000,5.5000,true,19.5000,7.8000"
    );
    expect(lines[2]).toBe("");
    expect(lines).toHaveLength(3);
  });

  it("is just the header when there are no settlements", () => {
    expect(settlementsToCsv([])).toBe(`${SETTLEMENT_CSV_COLUMNS.join(",")}\r\n`);
  });

  it("quotes commas and quotes, neutralises spreadsheet formulas in text, and leaves negative numbers alone", () => {
    const record = computeSettlementRecord(
      row({ invoice_type: '=HYPERLINK("x")', invoice_number: "INV, 2", payout_amount: "196.0000" })
    );
    const line = settlementsToCsv([record]).split("\r\n")[1];
    expect(line).toContain(`"INV, 2"`);
    expect(line).toContain(`"'=HYPERLINK(""x"")"`);
    expect(line).toContain(",-54.0000,");
  });

  it("leaves an empty cell for a missing invoice type", () => {
    const line = settlementsToCsv([computeSettlementRecord(row({ invoice_type: null }))]).split(
      "\r\n"
    )[1];
    expect(line.split(",")[2]).toBe("");
  });
});
