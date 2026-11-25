import {
  LIFECYCLE_HISTORY_DEFAULT_LIMIT,
  LIFECYCLE_HISTORY_MAX_LIMIT,
  decodeLifecycleHistoryCursor,
  encodeLifecycleHistoryCursor,
  parseLifecycleHistoryLimit,
  redactLifecycleHistoryRow,
  type LifecycleHistoryRow,
} from "../../src/lib/invoice-lifecycle-history";
import { InvoiceStatus } from "../../src/types/enums";

const INVOICE = "6f1c9a52-8a0e-4d3c-9b0a-0c7c1f3e2a11";
const OTHER_INVOICE = "0b8e2f41-3c5d-4e6f-8a9b-1c2d3e4f5a6b";
const ROW = "a3d5e7f9-1b2c-4d5e-8f90-123456789abc";

describe("lifecycle history cursor (issue #795)", () => {
  const cursor = { invoiceId: INVOICE, createdAt: "2026-11-24T10:15:30.123456Z", id: ROW };

  it("round-trips, keeping microseconds", () => {
    expect(decodeLifecycleHistoryCursor(encodeLifecycleHistoryCursor(cursor), INVOICE)).toEqual(
      cursor
    );
  });

  it("is URL-safe", () => {
    expect(encodeLifecycleHistoryCursor(cursor)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects a cursor issued for another invoice", () => {
    const foreign = encodeLifecycleHistoryCursor({ ...cursor, invoiceId: OTHER_INVOICE });
    expect(() => decodeLifecycleHistoryCursor(foreign, INVOICE)).toThrow(
      expect.objectContaining({ code: "invalid_cursor", statusCode: 400 })
    );
  });

  it.each([
    ["garbage", "not-a-cursor"],
    ["non-JSON base64", Buffer.from("hello").toString("base64url")],
    [
      "wrong version",
      Buffer.from(JSON.stringify({ v: 2, i: INVOICE, t: cursor.createdAt, id: ROW })).toString(
        "base64url"
      ),
    ],
    [
      "millisecond timestamp",
      Buffer.from(
        JSON.stringify({ v: 1, i: INVOICE, t: "2026-11-24T10:15:30.123Z", id: ROW })
      ).toString("base64url"),
    ],
    [
      "non-uuid id",
      Buffer.from(
        JSON.stringify({ v: 1, i: INVOICE, t: cursor.createdAt, id: "1 OR 1=1" })
      ).toString("base64url"),
    ],
    ["null payload", Buffer.from("null").toString("base64url")],
  ])("rejects a %s cursor with 400 invalid_cursor", (_case, raw) => {
    expect(() => decodeLifecycleHistoryCursor(raw, INVOICE)).toThrow(
      expect.objectContaining({ code: "invalid_cursor", statusCode: 400 })
    );
  });
});

describe("lifecycle history limit", () => {
  it.each([
    [undefined, LIFECYCLE_HISTORY_DEFAULT_LIMIT],
    ["", LIFECYCLE_HISTORY_DEFAULT_LIMIT],
    ["1", 1],
    [String(LIFECYCLE_HISTORY_MAX_LIMIT), LIFECYCLE_HISTORY_MAX_LIMIT],
  ])("parses %p as %p", (raw, expected) => {
    expect(parseLifecycleHistoryLimit(raw)).toBe(expected);
  });

  it.each(["0", "101", "-1", "2.5", "abc", "1e2"])("rejects %p with 400 invalid_limit", (raw) => {
    expect(() => parseLifecycleHistoryLimit(raw)).toThrow(
      expect.objectContaining({ code: "invalid_limit", statusCode: 400 })
    );
  });
});

describe("lifecycle history redaction", () => {
  const row = (overrides: Partial<LifecycleHistoryRow>): LifecycleHistoryRow => ({
    id: ROW,
    fromStatus: InvoiceStatus.PENDING,
    toStatus: InvoiceStatus.REJECTED,
    actorRole: "admin",
    actorId: "GADMINWALLET",
    trigger: "admin_rejected",
    reason: "Document unreadable",
    createdAt: new Date("2026-11-24T10:15:30.123Z"),
    ...overrides,
  });

  const seller = { id: "seller-1", stellarAddress: "GSELLER", isAdmin: false };
  const admin = { id: "admin-1", stellarAddress: "GADMIN", isAdmin: true };

  it("hides admin and system identities from the seller but keeps category, trigger and reason", () => {
    expect(redactLifecycleHistoryRow(row({}), seller)).toEqual({
      ...row({}),
      actorId: null,
    });
    expect(
      redactLifecycleHistoryRow(row({ actorRole: "system", actorId: "GSYSTEMJOB" }), seller).actorId
    ).toBeNull();
  });

  it("shows the seller their own id or wallet", () => {
    expect(
      redactLifecycleHistoryRow(row({ actorRole: "seller", actorId: "seller-1" }), seller).actorId
    ).toBe("seller-1");
    expect(
      redactLifecycleHistoryRow(row({ actorRole: "seller", actorId: "GSELLER" }), seller).actorId
    ).toBe("GSELLER");
  });

  it("shows admins every actor", () => {
    expect(redactLifecycleHistoryRow(row({}), admin).actorId).toBe("GADMINWALLET");
  });

  it("never exposes fields outside the documented shape", () => {
    const withExtra = { ...row({}), invoiceId: INVOICE, internal: "x" } as LifecycleHistoryRow;
    expect(Object.keys(redactLifecycleHistoryRow(withExtra, admin)).sort()).toEqual([
      "actorId",
      "actorRole",
      "createdAt",
      "fromStatus",
      "id",
      "reason",
      "toStatus",
      "trigger",
    ]);
  });
});
