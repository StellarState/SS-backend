import {
  LEDGER_TIME_MAX_FUTURE_SKEW_MS,
  parseLedgerTime,
  processingLagMs,
} from "@/lib/ledger-time";

describe("parseLedgerTime (#812)", () => {
  const now = new Date("2026-11-22T12:00:00.000Z");

  it.each([
    ["2026-08-25T12:06:00Z", "2026-08-25T12:06:00.000Z"],
    ["2026-08-25T12:06:00.123Z", "2026-08-25T12:06:00.123Z"],
    ["2026-08-25T14:06:00+02:00", "2026-08-25T12:06:00.000Z"],
    ["  2026-08-25T12:06:00Z  ", "2026-08-25T12:06:00.000Z"],
  ])("accepts %j", (raw, iso) => {
    const result = parseLedgerTime(raw, now);
    expect(result.ok && result.value.toISOString()).toBe(iso);
  });

  it.each([
    [undefined, "missing"],
    [null, "missing"],
    ["", "missing"],
    ["   ", "missing"],
    [1724587560, "unparseable"],
    ["not a date", "unparseable"],
    ["2026-08-25", "unparseable"],
    // No zone: `new Date()` would read this in the server's local time.
    ["2026-08-25T12:06:00", "unparseable"],
    // Impossible dates that `new Date()` silently rolls forward.
    ["2026-02-30T00:00:00Z", "unparseable"],
    ["2026-13-01T00:00:00Z", "unparseable"],
    ["2026-08-25T24:00:00Z", "unparseable"],
    ["1970-01-01T00:00:00Z", "before_network_genesis"],
    ["2014-12-31T23:59:59Z", "before_network_genesis"],
  ])("rejects %j as %s", (raw, reason) => {
    expect(parseLedgerTime(raw, now)).toEqual({ ok: false, reason });
  });

  it("tolerates small clock skew but rejects times further in the future", () => {
    const withinSkew = new Date(now.getTime() + LEDGER_TIME_MAX_FUTURE_SKEW_MS).toISOString();
    const beyondSkew = new Date(
      now.getTime() + LEDGER_TIME_MAX_FUTURE_SKEW_MS + 1000
    ).toISOString();
    expect(parseLedgerTime(withinSkew, now).ok).toBe(true);
    expect(parseLedgerTime(beyondSkew, now)).toEqual({ ok: false, reason: "in_future" });
  });

  it("accepts valid Date objects and rejects invalid ones", () => {
    expect(parseLedgerTime(new Date("2026-08-25T12:06:00Z"), now).ok).toBe(true);
    expect(parseLedgerTime(new Date("nope"), now)).toEqual({ ok: false, reason: "unparseable" });
  });
});

describe("processingLagMs", () => {
  it("is processed minus ledger time, and null when either is unknown", () => {
    const ledger = new Date("2026-08-25T12:00:00Z");
    expect(processingLagMs(ledger, new Date("2026-08-25T12:00:02.500Z"))).toBe(2500);
    expect(processingLagMs(ledger, null)).toBeNull();
    expect(processingLagMs(null, ledger)).toBeNull();
  });

  it("never reports negative lag", () => {
    expect(
      processingLagMs(new Date("2026-08-25T12:00:01Z"), new Date("2026-08-25T12:00:00Z"))
    ).toBe(0);
  });
});
