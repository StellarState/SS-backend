import crypto from "crypto";

/**
 * Compute an HMAC-SHA256 signature for a payload using the given secret.
 */
export function computeWebhookSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Verify that a signature matches the expected HMAC-SHA256 of the payload
 * computed with the given secret.
 *
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @returns `true` if the signature is valid, `false` otherwise.
 * Never throws — safe to use in webhook handlers.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  try {
    if (!payload || !signature || !secret) {
      return false;
    }

    const expected = computeWebhookSignature(payload, secret);

    // Constant-time comparison
    if (expected.length !== signature.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Header carrying the (milliseconds-since-epoch) timestamp the signature covers. */
export const WEBHOOK_TIMESTAMP_HEADER = "x-webhook-timestamp";

/** Header carrying the HMAC-SHA256 hex signature of `<timestamp>.<payload>`. */
export const WEBHOOK_SIGNATURE_HEADER = "x-webhook-signature";

/** Codes returned when a webhook signature verification fails. */
export type WebhookSignatureErrorCode =
  | "MISSING_TIMESTAMP"
  | "MISSING_SIGNATURE"
  | "MALFORMED_SIGNATURE"
  | "TIMESTAMP_OUT_OF_RANGE"
  | "TIMESTAMP_SKEWED"
  | "INVALID_SIGNATURE";

/** A typed, addressable webhook verification failure. */
export class WebhookSignatureError extends Error {
  constructor(
    public readonly code: WebhookSignatureErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

/** Default maximum acceptable skew between `now` and the signed timestamp. */
export const DEFAULT_MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

/**
 * Compute the signature over an optional timestamp and the raw payload.
 *
 * When a timestamp is supplied the signed content is `<timestamp>.<payload>`.
 * Providers commonly sign the timestamp plus the raw body so that a captured
 * signature cannot be replayed after the timestamp age expires.
 */
export function computeWebhookSignatureForTimestamp(
  payload: string,
  timestamp: string,
  secret: string
): string {
  return computeWebhookSignature(`${timestamp}.${payload}`, secret);
}

export type TimestampUnit = "s" | "ms" | "seconds" | "milliseconds" | "auto";

export interface VerifyWebhookHeadersOptions {
  /** Raw, unparsed request body exactly as it was received. */
  payload: string;
  /** Value of the signature header (`x-webhook-signature`), if present. */
  signature: string | undefined | null;
  /** Value of the timestamp header (`x-webhook-timestamp`), if present. */
  timestamp: string | number | undefined | null;
  /** The configured shared secret. */
  secret: string;
  /** Maximum allowed skew between `now()` and `timestamp` in milliseconds. */
  maxTimestampSkewMs?: number;
  /** Maximum allowed future skew in milliseconds. Defaults to 0 (future timestamps rejected). */
  maxFutureSkewMs?: number;
  /** Expected unit of numeric timestamps. Defaults to 'auto'. */
  unit?: TimestampUnit;
  /**
   * Override for the current time in milliseconds since the epoch. Injected so
   * tests (and replay windows) are deterministic. Defaults to `Date.now()`.
   */
  now?: () => number;
}

const ISO_8601_REGEX =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const RFC_2822_REGEX =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}:\d{2}(?:\s+(?:GMT|UTC|[+-]\d{4}))?$/i;

/**
 * Validates and parses a webhook timestamp into milliseconds since the epoch.
 *
 * Validates type, unit, and range to prevent replay-window bypasses:
 * - Unambiguously distinguishes seconds (10 digits / decimal) from milliseconds (13 digits).
 * - Enforces expected unit when configured ('s' vs 'ms').
 * - Rejects negative timestamps and unsupported formats with TIMESTAMP_OUT_OF_RANGE.
 */
export function parseTimestampMs(timestamp: string | number, unit: TimestampUnit = "auto"): number {
  if (typeof timestamp !== "string" && typeof timestamp !== "number") {
    throw new WebhookSignatureError(
      "TIMESTAMP_OUT_OF_RANGE",
      `'${WEBHOOK_TIMESTAMP_HEADER}' is not a valid timestamp.`
    );
  }

  if (typeof timestamp === "number") {
    if (!Number.isFinite(timestamp) || Number.isNaN(timestamp)) {
      throw new WebhookSignatureError(
        "TIMESTAMP_OUT_OF_RANGE",
        `'${WEBHOOK_TIMESTAMP_HEADER}' is not a valid timestamp.`
      );
    }
    if (timestamp < 0) {
      throw new WebhookSignatureError(
        "TIMESTAMP_OUT_OF_RANGE",
        `'${WEBHOOK_TIMESTAMP_HEADER}' cannot be negative.`
      );
    }
  }

  const trimmed = String(timestamp).trim();
  if (!trimmed) {
    throw new WebhookSignatureError(
      "MISSING_TIMESTAMP",
      `Missing '${WEBHOOK_TIMESTAMP_HEADER}' header.`
    );
  }

  if (trimmed.startsWith("-")) {
    throw new WebhookSignatureError(
      "TIMESTAMP_OUT_OF_RANGE",
      `'${WEBHOOK_TIMESTAMP_HEADER}' cannot be negative.`
    );
  }

  if (/^\d+(?:\.\d+)?[eE][+-]?\d+$/i.test(trimmed) || /^0[xXbBoO]/i.test(trimmed)) {
    throw new WebhookSignatureError(
      "TIMESTAMP_OUT_OF_RANGE",
      `'${WEBHOOK_TIMESTAMP_HEADER}' is not a valid timestamp.`
    );
  }

  const normalizedUnit = (unit || "auto").toLowerCase() as TimestampUnit;
  if (!["s", "ms", "seconds", "milliseconds", "auto"].includes(normalizedUnit)) {
    throw new Error(
      `Invalid timestamp unit '${unit}'. Must be 's', 'ms', 'seconds', 'milliseconds', or 'auto'.`
    );
  }

  // Integer timestamp
  if (/^\d+$/.test(trimmed)) {
    const numDigits = trimmed.length;
    const numVal = Number(trimmed);

    if (!Number.isSafeInteger(numVal) && numDigits > 16) {
      throw new WebhookSignatureError(
        "TIMESTAMP_OUT_OF_RANGE",
        `'${WEBHOOK_TIMESTAMP_HEADER}' is not a valid timestamp.`
      );
    }

    if (normalizedUnit === "s" || normalizedUnit === "seconds") {
      if (numDigits >= 12) {
        throw new WebhookSignatureError(
          "TIMESTAMP_OUT_OF_RANGE",
          `'${WEBHOOK_TIMESTAMP_HEADER}' unit mismatch: expected seconds.`
        );
      }
      return Math.round(numVal * 1000);
    }

    if (normalizedUnit === "ms" || normalizedUnit === "milliseconds") {
      if (numDigits <= 10) {
        throw new WebhookSignatureError(
          "TIMESTAMP_OUT_OF_RANGE",
          `'${WEBHOOK_TIMESTAMP_HEADER}' unit mismatch: expected milliseconds.`
        );
      }
      return numVal;
    }

    if (numDigits === 10) {
      return numVal * 1000;
    }
    if (numDigits === 13) {
      return numVal;
    }

    throw new WebhookSignatureError(
      "TIMESTAMP_OUT_OF_RANGE",
      `'${WEBHOOK_TIMESTAMP_HEADER}' is ambiguous or out of range.`
    );
  }

  // Decimal seconds (e.g. Stripe timestamp "1700000000.123")
  if (/^\d+\.\d+$/.test(trimmed)) {
    const [intPart] = trimmed.split(".");
    if (normalizedUnit === "ms" || normalizedUnit === "milliseconds") {
      throw new WebhookSignatureError(
        "TIMESTAMP_OUT_OF_RANGE",
        `'${WEBHOOK_TIMESTAMP_HEADER}' unit mismatch: expected milliseconds.`
      );
    }

    if (intPart.length !== 10) {
      throw new WebhookSignatureError(
        "TIMESTAMP_OUT_OF_RANGE",
        `'${WEBHOOK_TIMESTAMP_HEADER}' is ambiguous or out of range.`
      );
    }

    const floatVal = parseFloat(trimmed);
    if (!Number.isFinite(floatVal) || floatVal < 0) {
      throw new WebhookSignatureError(
        "TIMESTAMP_OUT_OF_RANGE",
        `'${WEBHOOK_TIMESTAMP_HEADER}' is not a valid timestamp.`
      );
    }
    return Math.round(floatVal * 1000);
  }

  // Date strings (ISO-8601 or RFC-2822)
  if (ISO_8601_REGEX.test(trimmed) || RFC_2822_REGEX.test(trimmed)) {
    if (
      normalizedUnit === "s" ||
      normalizedUnit === "seconds" ||
      normalizedUnit === "ms" ||
      normalizedUnit === "milliseconds"
    ) {
      throw new WebhookSignatureError(
        "TIMESTAMP_OUT_OF_RANGE",
        `'${WEBHOOK_TIMESTAMP_HEADER}' unit mismatch: expected numeric ${normalizedUnit}.`
      );
    }

    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed) || !Number.isFinite(parsed) || parsed < 0) {
      throw new WebhookSignatureError(
        "TIMESTAMP_OUT_OF_RANGE",
        `'${WEBHOOK_TIMESTAMP_HEADER}' is not a valid timestamp.`
      );
    }
    return parsed;
  }

  throw new WebhookSignatureError(
    "TIMESTAMP_OUT_OF_RANGE",
    `'${WEBHOOK_TIMESTAMP_HEADER}' is not a valid timestamp.`
  );
}

/**
 * Verify that a webhook request is authentic: a signature header must be
 * present, well-formed, unexpired (within the allowed timestamp skew), and
 * must match the HMAC-SHA256 of `<timestamp>.<payload>` computed with the
 * configured secret.
 *
 * @returns The verified timestamp header value (as a numeric string) on
 *   success so callers can echo it / log it.
 * @throws {WebhookSignatureError} with a stable, enumerable code for any
 *   failure. Never returns `false` — every rejection is a typed error that a
 *   handler can map to a 4xx response.
 */
export function verifyWebhookSignatureHeaders(options: VerifyWebhookHeadersOptions): string {
  const {
    payload,
    signature,
    timestamp,
    secret,
    maxTimestampSkewMs = DEFAULT_MAX_TIMESTAMP_SKEW_MS,
    maxFutureSkewMs = 0,
    unit = "auto",
    now = () => Date.now(),
  } = options;

  if (!secret) {
    throw new WebhookSignatureError("INVALID_SIGNATURE", "Webhook secret is not configured.");
  }

  if (
    timestamp === undefined ||
    timestamp === null ||
    (typeof timestamp === "string" && timestamp.trim() === "")
  ) {
    throw new WebhookSignatureError(
      "MISSING_TIMESTAMP",
      `Missing '${WEBHOOK_TIMESTAMP_HEADER}' header.`
    );
  }

  if (
    signature === undefined ||
    signature === null ||
    (typeof signature === "string" && signature.trim() === "")
  ) {
    throw new WebhookSignatureError(
      "MISSING_SIGNATURE",
      `Missing '${WEBHOOK_SIGNATURE_HEADER}' header.`
    );
  }

  // Validate clock source before comparing against allowed skew
  if (typeof now !== "function") {
    throw new Error("Invalid clock source: 'now' must be a function.");
  }

  const currentNow = now();
  if (
    typeof currentNow !== "number" ||
    Number.isNaN(currentNow) ||
    !Number.isFinite(currentNow) ||
    currentNow <= 0
  ) {
    throw new Error(
      "Invalid clock source: 'now()' must return a positive finite timestamp in milliseconds."
    );
  }

  // Validate allowed skew configuration
  if (
    typeof maxTimestampSkewMs !== "number" ||
    Number.isNaN(maxTimestampSkewMs) ||
    !Number.isFinite(maxTimestampSkewMs) ||
    maxTimestampSkewMs < 0
  ) {
    throw new Error("maxTimestampSkewMs must be a non-negative finite number.");
  }

  // Validate type, unit, and range before comparing against allowed skew
  const timestampMs = parseTimestampMs(timestamp, unit);

  // Compare against allowed skew deterministically
  const skewMs = currentNow - timestampMs;

  if (skewMs < -maxFutureSkewMs) {
    throw new WebhookSignatureError(
      "TIMESTAMP_SKEWED",
      `'${WEBHOOK_TIMESTAMP_HEADER}' is in the future.`
    );
  }

  if (skewMs > maxTimestampSkewMs) {
    throw new WebhookSignatureError(
      "TIMESTAMP_SKEWED",
      `'${WEBHOOK_TIMESTAMP_HEADER}' is outside the allowed ${maxTimestampSkewMs}ms window.`
    );
  }

  // Signature format must be a 64-char hex digest (HMAC-SHA256).
  const normalizedSig = typeof signature === "string" ? signature.trim() : "";
  if (!/^[0-9a-f]{64}$/i.test(normalizedSig)) {
    throw new WebhookSignatureError(
      "MALFORMED_SIGNATURE",
      "'x-webhook-signature' is not a valid HMAC-SHA256 hex signature."
    );
  }

  const rawTimestampStr = String(timestamp).trim();
  const expected = computeWebhookSignatureForTimestamp(payload, rawTimestampStr, secret);

  if (expected.length !== normalizedSig.length) {
    throw new WebhookSignatureError(
      "MALFORMED_SIGNATURE",
      "'x-webhook-signature' has an invalid length."
    );
  }

  const matches = crypto.timingSafeEqual(
    Buffer.from(expected.toLowerCase()),
    Buffer.from(normalizedSig.toLowerCase())
  );

  if (!matches) {
    throw new WebhookSignatureError("INVALID_SIGNATURE", "Webhook signature verification failed.");
  }

  return rawTimestampStr;
}
