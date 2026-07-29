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
  secret: string,
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
