import jwt from "jsonwebtoken";

export const DEFAULT_JWT_KEY_ID = "v1";
export const JWT_ALGORITHM = "HS256" as const;

export interface JwtKey {
  id: string;
  secret: string;
}

export interface JwtPreviousKey {
  key: JwtKey;
  /** Tokens signed with the previous key stop verifying at this instant. */
  validUntil: Date;
}

export interface JwtKeyRing {
  signing: JwtKey;
  previous: JwtPreviousKey | null;
  revokedKeyIds: ReadonlySet<string>;
}

export interface JwtKeyRingStatus {
  currentKeyId: string;
  previous: { keyId: string; validUntil: string; overlapActive: boolean } | null;
  revokedKeyIds: string[];
}

export function singleKeyRing(secret: string, keyId: string = DEFAULT_JWT_KEY_ID): JwtKeyRing {
  return { signing: { id: keyId, secret }, previous: null, revokedKeyIds: new Set() };
}

/**
 * Builds the key ring from environment variables:
 *
 * - `JWT_SECRET` / `JWT_KEY_ID` (default `v1`): the key used to sign new tokens.
 * - `JWT_PREVIOUS_SECRET` / `JWT_PREVIOUS_KEY_ID` / `JWT_PREVIOUS_VALID_UNTIL`:
 *   the outgoing key, still accepted for verification until `JWT_PREVIOUS_VALID_UNTIL`.
 * - `JWT_REVOKED_KEY_IDS`: comma-separated key ids rejected immediately.
 *
 * Tokens without a `kid` header are treated as key id `v1`, so tokens issued
 * before key ids existed keep verifying while `v1` is the signing or previous key.
 */
export function loadJwtKeyRing(env: NodeJS.ProcessEnv = process.env): JwtKeyRing {
  const secret = env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error("JWT_SECRET is required");
  }
  const signingId = env.JWT_KEY_ID?.trim() || DEFAULT_JWT_KEY_ID;
  const revokedKeyIds = new Set(
    (env.JWT_REVOKED_KEY_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );

  const previousSecret = env.JWT_PREVIOUS_SECRET?.trim();
  let previous: JwtPreviousKey | null = null;
  if (previousSecret) {
    const previousId = env.JWT_PREVIOUS_KEY_ID?.trim() || DEFAULT_JWT_KEY_ID;
    const validUntilRaw = env.JWT_PREVIOUS_VALID_UNTIL?.trim();
    const validUntil = validUntilRaw ? new Date(validUntilRaw) : null;
    if (!validUntil || Number.isNaN(validUntil.getTime())) {
      throw new Error("JWT_PREVIOUS_VALID_UNTIL must be an ISO-8601 timestamp when JWT_PREVIOUS_SECRET is set");
    }
    if (previousId === signingId) {
      throw new Error("JWT_PREVIOUS_KEY_ID must differ from JWT_KEY_ID; bump JWT_KEY_ID when rotating");
    }
    if (previousSecret === secret) {
      throw new Error("JWT_PREVIOUS_SECRET must differ from JWT_SECRET");
    }
    previous = { key: { id: previousId, secret: previousSecret }, validUntil };
  }

  if (revokedKeyIds.has(signingId)) {
    throw new Error("JWT_KEY_ID cannot be listed in JWT_REVOKED_KEY_IDS");
  }

  return { signing: { id: signingId, secret }, previous, revokedKeyIds };
}

export function resolveVerificationKey(
  ring: JwtKeyRing,
  keyId: string | undefined,
  now: Date,
): JwtKey {
  const id = keyId ?? DEFAULT_JWT_KEY_ID;
  if (ring.revokedKeyIds.has(id)) {
    throw new jwt.JsonWebTokenError("signing key has been revoked");
  }
  if (id === ring.signing.id) {
    return ring.signing;
  }
  if (ring.previous && id === ring.previous.key.id) {
    if (now.getTime() < ring.previous.validUntil.getTime()) {
      return ring.previous.key;
    }
    throw new jwt.JsonWebTokenError("signing key overlap has ended");
  }
  throw new jwt.JsonWebTokenError("unknown signing key id");
}

export function signWithKeyRing(
  payload: string | Buffer | object,
  ring: JwtKeyRing,
  options: jwt.SignOptions,
): string {
  return jwt.sign(payload, ring.signing.secret, {
    ...options,
    algorithm: JWT_ALGORITHM,
    keyid: ring.signing.id,
  });
}

export function verifyWithKeyRing(
  token: string,
  ring: JwtKeyRing,
  now: Date = new Date(),
): jwt.JwtPayload {
  const decoded = jwt.decode(token, { complete: true });
  const header = decoded?.header as { kid?: unknown } | undefined;
  const keyId = typeof header?.kid === "string" ? header.kid : undefined;
  const key = resolveVerificationKey(ring, keyId, now);
  const verified = jwt.verify(token, key.secret, {
    algorithms: [JWT_ALGORITHM],
    clockTimestamp: Math.floor(now.getTime() / 1000),
  });
  if (typeof verified === "string") {
    throw new jwt.JsonWebTokenError("unexpected string payload");
  }
  return verified;
}

export function describeJwtKeyRing(ring: JwtKeyRing, now: Date = new Date()): JwtKeyRingStatus {
  return {
    currentKeyId: ring.signing.id,
    previous: ring.previous
      ? {
          keyId: ring.previous.key.id,
          validUntil: ring.previous.validUntil.toISOString(),
          overlapActive: now.getTime() < ring.previous.validUntil.getTime(),
        }
      : null,
    revokedKeyIds: [...ring.revokedKeyIds].sort(),
  };
}
