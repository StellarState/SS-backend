import {
  computeWebhookSignature,
  computeWebhookSignatureForTimestamp,
  WebhookSignatureError,
  verifyWebhookSignatureHeaders,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "../../src/utils/webhook-signature";

/**
 * Unit coverage for issue #223: webhook authentication must accept only
 * correctly signed payloads with the configured secret, and every rejection
 * (modified payload / signature / timestamp, missing or malformed headers)
 * must be surfaced as a typed, addressable validation error.
 */

/** Asserts that `fn` throws a WebhookSignatureError carrying `code`. */
function expectWebhookError(fn: () => unknown, code: WebhookSignatureError["code"]): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WebhookSignatureError);
    expect((error as WebhookSignatureError).code).toBe(code);
    return;
  }
  throw new Error(`Expected a WebhookSignatureError with code "${code}" but it did not throw.`);
}

describe("computeWebhookSignatureForTimestamp", () => {
  it("signs `<timestamp>.<payload>` with the given secret", () => {
    const secret = "whsec_test_secret_12345";
    const payload = '{"event":"invoice.paid","amount":6000}';
    const timestamp = "1700000000000";

    const signature = computeWebhookSignatureForTimestamp(payload, timestamp, secret);

    expect(signature).toBe(computeWebhookSignature(`${timestamp}.${payload}`, secret));
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifyWebhookSignatureHeaders", () => {
  const SECRET = "whsec_test_secret_12345";
  const PAYLOAD = '{"event":"invoice.paid","amount":6000}';
  const NOW_MS = 1_700_000_000_000;

  const now = () => NOW_MS;

  function validSignature(timestamp: number | string = NOW_MS): string {
    return computeWebhookSignatureForTimestamp(PAYLOAD, String(timestamp), SECRET);
  }

  describe("acceptance", () => {
    it("accepts a correctly signed payload within the timestamp window", () => {
      const timestamp = String(NOW_MS - 1_000);

      const result = verifyWebhookSignatureHeaders({
        payload: PAYLOAD,
        signature: validSignature(NOW_MS - 1_000),
        timestamp,
        secret: SECRET,
        now,
      });

      expect(result).toBe(timestamp);
    });

    it("accepts the exact-now timestamp", () => {
      expect(
        verifyWebhookSignatureHeaders({
          payload: PAYLOAD,
          signature: validSignature(NOW_MS),
          timestamp: String(NOW_MS),
          secret: SECRET,
          now,
        })
      ).toBe(String(NOW_MS));
    });
  });

  describe("rejecting modifications", () => {
    it("rejects a payload that no longer matches the signature", () => {
      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: '{"event":"invoice.paid","amount":9999}',
            signature: validSignature(),
            timestamp: String(NOW_MS),
            secret: SECRET,
            now,
          }),
        "INVALID_SIGNATURE"
      );
    });

    it("rejects a modified signature", () => {
      const tampered = `${validSignature().slice(0, 63)}0`;

      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: tampered,
            timestamp: String(NOW_MS),
            secret: SECRET,
            now,
          }),
        "INVALID_SIGNATURE"
      );
    });

    it("rejects a signature produced with the wrong secret", () => {
      const wrongSig = computeWebhookSignatureForTimestamp(
        PAYLOAD,
        String(NOW_MS),
        "different-secret"
      );

      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: wrongSig,
            timestamp: String(NOW_MS),
            secret: SECRET,
            now,
          }),
        "INVALID_SIGNATURE"
      );
    });

    it("rejects a timestamp that was changed after signing", () => {
      const signedTimestamp = String(NOW_MS - 2_000);

      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: validSignature(NOW_MS - 2_000),
            timestamp: String(NOW_MS),
            secret: SECRET,
            now,
          }),
        "INVALID_SIGNATURE"
      );
    });
  });

  describe("missing headers", () => {
    it("throws MISSING_SIGNATURE when the signature header is absent", () => {
      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: undefined,
            timestamp: String(NOW_MS),
            secret: SECRET,
            now,
          }),
        "MISSING_SIGNATURE"
      );
    });

    it("throws MISSING_SIGNATURE when the signature header is empty", () => {
      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: "",
            timestamp: String(NOW_MS),
            secret: SECRET,
            now,
          }),
        "MISSING_SIGNATURE"
      );
    });

    it("throws MISSING_SIGNATURE when the signature header is an empty string / null", () => {
      for (const missing of [null, ""]) {
        expectWebhookError(
          () =>
            verifyWebhookSignatureHeaders({
              payload: PAYLOAD,
              signature: missing,
              timestamp: String(NOW_MS),
              secret: SECRET,
              now,
            }),
          "MISSING_SIGNATURE"
        );
      }
    });

    it("throws MISSING_TIMESTAMP when the timestamp header is absent/null/empty", () => {
      for (const missing of [undefined, null, ""]) {
        expectWebhookError(
          () =>
            verifyWebhookSignatureHeaders({
              payload: PAYLOAD,
              signature: validSignature(),
              timestamp: missing,
              secret: SECRET,
              now,
            }),
          "MISSING_TIMESTAMP"
        );
      }
    });
  });

  describe("malformed headers", () => {
    it("throws MALFORMED_SIGNATURE for a non-hex signature", () => {
      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: "not-a-hex-signature",
            timestamp: String(NOW_MS),
            secret: SECRET,
            now,
          }),
        "MALFORMED_SIGNATURE"
      );
    });

    it("throws MALFORMED_SIGNATURE for a signature of the wrong length", () => {
      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: "a".repeat(10),
            timestamp: String(NOW_MS),
            secret: SECRET,
            now,
          }),
        "MALFORMED_SIGNATURE"
      );
    });

    it("throws TIMESTAMP_OUT_OF_RANGE for an unparseable timestamp", () => {
      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: validSignature(),
            timestamp: "not-a-timestamp",
            secret: SECRET,
            now,
          }),
        "TIMESTAMP_OUT_OF_RANGE"
      );
    });

    it("throws TIMESTAMP_SKEWED for a timestamp too far in the past", () => {
      const oldTs = NOW_MS - 11 * 60 * 1000; // 11 minutes old, default window is 5 mins

      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: validSignature(oldTs),
            timestamp: String(oldTs),
            secret: SECRET,
            now,
          }),
        "TIMESTAMP_SKEWED"
      );
    });

    it("throws TIMESTAMP_SKEWED for a timestamp too far in the future", () => {
      const futureTs = NOW_MS + 11 * 60 * 1000;

      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: validSignature(futureTs),
            timestamp: String(futureTs),
            secret: SECRET,
            now,
          }),
        "TIMESTAMP_SKEWED"
      );
    });
  });

  describe("configured skew window", () => {
    it("honours a custom maxTimestampSkewMs", () => {
      const withinWindow = NOW_MS - 2_000;

      expect(() =>
        verifyWebhookSignatureHeaders({
          payload: PAYLOAD,
          signature: validSignature(withinWindow),
          timestamp: String(withinWindow),
          secret: SECRET,
          maxTimestampSkewMs: 5_000,
          now,
        })
      ).not.toThrow();

      const outsideWindow = NOW_MS - 10_000;

      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: validSignature(outsideWindow),
            timestamp: String(outsideWindow),
            secret: SECRET,
            maxTimestampSkewMs: 5_000,
            now,
          }),
        "TIMESTAMP_SKEWED"
      );
    });
  });

  describe("seconds and milliseconds disambiguation (#803)", () => {
    it("accepts 10-digit epoch seconds in auto mode", () => {
      const tsSeconds = String(Math.floor((NOW_MS - 2_000) / 1_000));
      const res = verifyWebhookSignatureHeaders({
        payload: PAYLOAD,
        signature: validSignature(tsSeconds),
        timestamp: tsSeconds,
        secret: SECRET,
        now,
      });
      expect(res).toBe(tsSeconds);
    });

    it("accepts 13-digit epoch milliseconds in auto mode", () => {
      const tsMs = String(NOW_MS - 2_000);
      const res = verifyWebhookSignatureHeaders({
        payload: PAYLOAD,
        signature: validSignature(tsMs),
        timestamp: tsMs,
        secret: SECRET,
        now,
      });
      expect(res).toBe(tsMs);
    });

    it("rejects ambiguous digit counts in auto mode", () => {
      for (const ambiguous of ["12345", "17000000000", "170000000000"]) {
        expectWebhookError(
          () =>
            verifyWebhookSignatureHeaders({
              payload: PAYLOAD,
              signature: validSignature(ambiguous),
              timestamp: ambiguous,
              secret: SECRET,
              now,
            }),
          "TIMESTAMP_OUT_OF_RANGE"
        );
      }
    });

    it("enforces unit: 's' and rejects millisecond timestamps", () => {
      const tsSeconds = String(Math.floor((NOW_MS - 1_000) / 1_000));
      expect(
        verifyWebhookSignatureHeaders({
          payload: PAYLOAD,
          signature: validSignature(tsSeconds),
          timestamp: tsSeconds,
          secret: SECRET,
          unit: "s",
          now,
        })
      ).toBe(tsSeconds);

      const tsMs = String(NOW_MS - 1_000);
      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: validSignature(tsMs),
            timestamp: tsMs,
            secret: SECRET,
            unit: "s",
            now,
          }),
        "TIMESTAMP_OUT_OF_RANGE"
      );
    });

    it("enforces unit: 'ms' and rejects second timestamps", () => {
      const tsMs = String(NOW_MS - 1_000);
      expect(
        verifyWebhookSignatureHeaders({
          payload: PAYLOAD,
          signature: validSignature(tsMs),
          timestamp: tsMs,
          secret: SECRET,
          unit: "ms",
          now,
        })
      ).toBe(tsMs);

      const tsSeconds = String(Math.floor((NOW_MS - 1_000) / 1_000));
      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: validSignature(tsSeconds),
            timestamp: tsSeconds,
            secret: SECRET,
            unit: "ms",
            now,
          }),
        "TIMESTAMP_OUT_OF_RANGE"
      );
    });
  });

  describe("negative and future timestamp rejection (#803)", () => {
    it("rejects negative timestamps with TIMESTAMP_OUT_OF_RANGE", () => {
      for (const neg of ["-1", "-100", "-1700000000", "-1700000000000"]) {
        expectWebhookError(
          () =>
            verifyWebhookSignatureHeaders({
              payload: PAYLOAD,
              signature: validSignature(neg),
              timestamp: neg,
              secret: SECRET,
              now,
            }),
          "TIMESTAMP_OUT_OF_RANGE"
        );
      }
    });

    it("rejects future timestamps with TIMESTAMP_SKEWED", () => {
      for (const futureMs of [NOW_MS + 1, NOW_MS + 1_000, NOW_MS + 60_000]) {
        expectWebhookError(
          () =>
            verifyWebhookSignatureHeaders({
              payload: PAYLOAD,
              signature: validSignature(futureMs),
              timestamp: String(futureMs),
              secret: SECRET,
              now,
            }),
          "TIMESTAMP_SKEWED"
        );
      }
    });
  });

  describe("deterministic boundary skew (#803)", () => {
    const maxSkew = 5_000;

    it("accepts exact now (skew = 0)", () => {
      expect(
        verifyWebhookSignatureHeaders({
          payload: PAYLOAD,
          signature: validSignature(NOW_MS),
          timestamp: String(NOW_MS),
          secret: SECRET,
          maxTimestampSkewMs: maxSkew,
          now,
        })
      ).toBe(String(NOW_MS));
    });

    it("rejects exact now + 1ms (future)", () => {
      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: validSignature(NOW_MS + 1),
            timestamp: String(NOW_MS + 1),
            secret: SECRET,
            maxTimestampSkewMs: maxSkew,
            now,
          }),
        "TIMESTAMP_SKEWED"
      );
    });

    it("accepts exact skew boundary (now - maxTimestampSkewMs)", () => {
      const boundaryTs = NOW_MS - maxSkew;
      expect(
        verifyWebhookSignatureHeaders({
          payload: PAYLOAD,
          signature: validSignature(boundaryTs),
          timestamp: String(boundaryTs),
          secret: SECRET,
          maxTimestampSkewMs: maxSkew,
          now,
        })
      ).toBe(String(boundaryTs));
    });

    it("rejects exact skew boundary + 1ms (now - maxTimestampSkewMs - 1)", () => {
      const pastBoundaryTs = NOW_MS - maxSkew - 1;
      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: validSignature(pastBoundaryTs),
            timestamp: String(pastBoundaryTs),
            secret: SECRET,
            maxTimestampSkewMs: maxSkew,
            now,
          }),
        "TIMESTAMP_SKEWED"
      );
    });
  });

  describe("provider format tests (#803)", () => {
    it("accepts Stripe-style decimal seconds timestamp", () => {
      const stripeTs = "1699999999.500";
      const res = verifyWebhookSignatureHeaders({
        payload: PAYLOAD,
        signature: validSignature(stripeTs),
        timestamp: stripeTs,
        secret: SECRET,
        now,
      });
      expect(res).toBe(stripeTs);
    });

    it("accepts Svix/Slack 10-digit epoch seconds timestamp", () => {
      const svixTs = "1699999998";
      const res = verifyWebhookSignatureHeaders({
        payload: PAYLOAD,
        signature: validSignature(svixTs),
        timestamp: svixTs,
        secret: SECRET,
        now,
      });
      expect(res).toBe(svixTs);
    });

    it("accepts ISO-8601 UTC timestamp", () => {
      const isoTs = new Date(NOW_MS - 2_000).toISOString();
      const res = verifyWebhookSignatureHeaders({
        payload: PAYLOAD,
        signature: validSignature(isoTs),
        timestamp: isoTs,
        secret: SECRET,
        now,
      });
      expect(res).toBe(isoTs);
    });

    it("accepts RFC 2822 date timestamp", () => {
      const rfcTs = new Date(NOW_MS - 2_000).toUTCString();
      const res = verifyWebhookSignatureHeaders({
        payload: PAYLOAD,
        signature: validSignature(rfcTs),
        timestamp: rfcTs,
        secret: SECRET,
        now,
      });
      expect(res).toBe(rfcTs);
    });

    it("rejects scientific notation and hex strings", () => {
      for (const malformed of ["1e12", "1.7e12", "0x6554f000"]) {
        expectWebhookError(
          () =>
            verifyWebhookSignatureHeaders({
              payload: PAYLOAD,
              signature: validSignature(malformed),
              timestamp: malformed,
              secret: SECRET,
              now,
            }),
          "TIMESTAMP_OUT_OF_RANGE"
        );
      }
    });
  });

  describe("clock source and configuration validation (#803)", () => {
    it("rejects non-function clock source", () => {
      expect(() =>
        verifyWebhookSignatureHeaders({
          payload: PAYLOAD,
          signature: validSignature(),
          timestamp: String(NOW_MS),
          secret: SECRET,
          now: "not-a-fn" as unknown as () => number,
        })
      ).toThrow("Invalid clock source");
    });

    it("rejects clock source returning non-finite or non-positive value", () => {
      for (const badNow of [NaN, Infinity, -100, 0]) {
        expect(() =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: validSignature(),
            timestamp: String(NOW_MS),
            secret: SECRET,
            now: () => badNow,
          })
        ).toThrow("Invalid clock source");
      }
    });

    it("rejects negative or non-finite maxTimestampSkewMs", () => {
      for (const badSkew of [-1, NaN, Infinity]) {
        expect(() =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: validSignature(),
            timestamp: String(NOW_MS),
            secret: SECRET,
            maxTimestampSkewMs: badSkew,
            now,
          })
        ).toThrow("maxTimestampSkewMs must be a non-negative finite number");
      }
    });
  });
});
