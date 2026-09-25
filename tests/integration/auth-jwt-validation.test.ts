import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Networks } from "stellar-sdk";
import request from "supertest";

import { createApp } from "../../src/app";
import { MAX_BEARER_TOKEN_LENGTH } from "../../src/middleware/auth.middleware";
import { AuthService } from "../../src/services/auth.service";
import type {
  ChallengeRepositoryContract,
  UserRepositoryContract,
} from "../../src/services/auth.service";
import { User } from "../../src/models/User.model";
import { KYCStatus, UserType } from "../../src/types/enums";

// ── In-memory repositories ────────────────────────────────────────────────────

type InMemoryUser = User;

interface InMemoryChallenge {
  id: string;
  stellarAddress: string;
  nonceHash: string;
  message: string;
  network: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

class InMemoryUserRepository implements UserRepositoryContract {
  private readonly users = new Map<string, InMemoryUser>();

  async findById(id: string) {
    return this.users.get(id) ?? null;
  }

  async findByStellarAddress(stellarAddress: string) {
    return [...this.users.values()].find((user) => user.stellarAddress === stellarAddress) ?? null;
  }

  async findByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email) ?? null;
  }

  async findAll(options?: {
    skip?: number;
    take?: number;
    cursor?: string;
    order?: "ASC" | "DESC";
  }) {
    let results = [...this.users.values()].filter((u) => !u.deletedAt);
    results.sort((a, b) =>
      options?.order === "ASC" ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id)
    );
    if (options?.cursor) {
      const cursorIndex = results.findIndex((u) => u.id === options.cursor);
      if (cursorIndex >= 0) {
        results = results.slice(cursorIndex + 1);
      }
    }
    if (options?.skip) {
      results = results.slice(options.skip);
    }
    if (options?.take) {
      results = results.slice(0, options.take);
    }
    return results;
  }

  async count(options?: { cursor?: string }): Promise<number> {
    let results = [...this.users.values()].filter((u) => !u.deletedAt);
    if (options?.cursor) {
      const cursorIndex = results.findIndex((u) => u.id === options.cursor);
      if (cursorIndex >= 0) {
        results = results.slice(0, cursorIndex);
      }
    }
    return results.length;
  }

  async save(user: Partial<InMemoryUser>) {
    const now = new Date();
    const entity: InMemoryUser = {
      id: crypto.randomUUID(),
      stellarAddress: user.stellarAddress ?? "",
      email: user.email ?? null,
      userType: user.userType ?? UserType.INVESTOR,
      kycStatus: user.kycStatus ?? KYCStatus.PENDING,
      isKycVerified: user.isKycVerified ?? false,
      createdAt: user.createdAt ?? now,
      updatedAt: user.updatedAt ?? now,
      deletedAt: user.deletedAt ?? null,
      invoices: user.invoices ?? [],
      investments: user.investments ?? [],
      transactions: user.transactions ?? [],
      kycVerifications: user.kycVerifications ?? [],
      notifications: user.notifications ?? [],
    };

    this.users.set(entity.id, entity);
    return entity;
  }
}

class InMemoryChallengeRepository implements ChallengeRepositoryContract {
  readonly challenges = new Map<string, InMemoryChallenge>();

  async create(input: InMemoryChallenge) {
    const challenge: InMemoryChallenge = {
      id: crypto.randomUUID(),
      stellarAddress: input.stellarAddress,
      nonceHash: input.nonceHash,
      message: input.message,
      network: input.network,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      consumedAt: null,
    };

    this.challenges.set(challenge.id, challenge);
    return challenge;
  }

  async findByAddressAndNonceHash(stellarAddress: string, nonceHash: string) {
    return (
      [...this.challenges.values()].find(
        (challenge) =>
          challenge.stellarAddress === stellarAddress && challenge.nonceHash === nonceHash
      ) ?? null
    );
  }

  async consume(id: string, consumedAt: Date) {
    const challenge = this.challenges.get(id);

    if (!challenge || challenge.consumedAt) {
      return false;
    }

    challenge.consumedAt = consumedAt;
    return true;
  }

  async deleteExpired(before: Date): Promise<number> {
    let count = 0;
    for (const [id, challenge] of this.challenges.entries()) {
      if (challenge.expiresAt < before || (challenge.consumedAt && challenge.consumedAt < before)) {
        this.challenges.delete(id);
        count++;
      }
    }
    return count;
  }

  async countByStatus(status: "active" | "consumed" | "expired"): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const challenge of this.challenges.values()) {
      if (status === "active" && !challenge.consumedAt && challenge.expiresAt > now) count++;
      if (status === "consumed" && challenge.consumedAt) count++;
      if (status === "expired" && !challenge.consumedAt && challenge.expiresAt <= now) count++;
    }
    return count;
  }
}

// ── Test helpers ──────────────────────────────────────────────────────────────

const VALID_JWT_SECRET = "valid-test-secret";
const ME_PATH = "/api/v1/auth/me";

/**
 * Canonical messages (see src/middleware/auth.middleware.ts and
 * src/services/auth.service.ts#getCurrentUser). Every failure mode answers 401
 * with the standard envelope; only the message tells them apart.
 */
const INVALID_TOKEN_MESSAGE = "Invalid or expired token."; // unverifiable / undecodable token
const INVALID_PAYLOAD_MESSAGE = "Invalid token payload."; // verified token, missing/empty sub
const UNKNOWN_USER_MESSAGE = "User no longer exists."; // verified token, sub resolves to no user
const MISSING_TOKEN_MESSAGE = "Authorization token is required."; // no usable Bearer credential

type SignOverrides = jwt.SignOptions & { secret?: string };

let app: ReturnType<typeof createApp>;
let userRepository: InMemoryUserRepository;

function createTestApp() {
  const repository = new InMemoryUserRepository();
  const authService = new AuthService({
    userRepository: repository,
    challengeRepository: new InMemoryChallengeRepository(),
    config: {
      jwt: {
        secret: VALID_JWT_SECRET,
        expiresIn: "15m",
      },
      auth: {
        challengeTtlMs: 60_000,
      },
      stellar: {
        network: "testnet",
        networkPassphrase: Networks.TESTNET,
      },
    },
  });

  return { app: createApp({ authService }), userRepository: repository };
}

/** Sign a token with the service secret and a 15 minute lifetime unless overridden. */
function signToken(
  payload: Record<string, unknown>,
  { secret = VALID_JWT_SECRET, expiresIn = "15m", ...options }: SignOverrides = {}
): string {
  return jwt.sign(payload, secret, { expiresIn, ...options });
}

/** Base claims for a well-formed token; override per case. */
function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: "GTESTSUBJECT",
    stellarAddress: "GTESTSUBJECT",
    userId: crypto.randomUUID(),
    ...overrides,
  };
}

/** Issue GET /api/v1/auth/me with the given Authorization header value (or none). */
function getMe(authorization?: string) {
  const req = request(app).get(ME_PATH);
  return authorization === undefined ? req : req.set("Authorization", authorization);
}

/**
 * Assert the standard 401 rejection envelope. Centralising this keeps every
 * case checking the same contract — status, `success:false`, a string
 * `error.message`, and no `data` — so an envelope regression fails once and
 * loudly. It also asserts the response never reflects the presented
 * credential back to the caller.
 */
function expectRejected(
  response: Awaited<ReturnType<typeof getMe>>,
  expectedMessage?: string,
  presentedToken?: string
): void {
  expect(response.status).toBe(401);
  expect(response.body).toHaveProperty("success", false);
  expect(response.body).toHaveProperty("error");
  expect(typeof response.body.error?.message).toBe("string");
  expect(response.body).not.toHaveProperty("data");
  expect(response.body).not.toHaveProperty("user");
  if (expectedMessage !== undefined) {
    expect(response.body.error.message).toBe(expectedMessage);
  }
  if (presentedToken) {
    expect(JSON.stringify(response.body)).not.toContain(presentedToken);
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// Hand-rolled tokens that jsonwebtoken cannot produce directly.
function twoSegmentToken(): string {
  return `${base64UrlJson({ alg: "HS256", typ: "JWT" })}.${base64UrlJson({
    sub: "GTESTADDRESS",
    stellarAddress: "GTESTADDRESS",
  })}`;
}

function undecodablePayloadToken(): string {
  return `${base64UrlJson({ alg: "HS256", typ: "JWT" })}.!!!invalid-base64!!!.signature`;
}

/** Correct header/payload shape, but signed with a key the server does not hold. */
function wrongKeySignatureToken(): string {
  const header = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlJson({
    sub: "GTAMPEREDADDR",
    stellarAddress: "GTAMPEREDADDR",
    userId: crypto.randomUUID(),
    iat: now,
    exp: now + 900,
  });
  const signature = crypto
    .createHmac("sha256", "wrong-secret")
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/** A genuine token whose payload was swapped after signing. */
function tamperedPayloadToken(): string {
  const [header, , signature] = signToken(claims({ sub: "GSOMEONEELSE" })).split(".");
  const forgedPayload = base64UrlJson({
    ...claims({ sub: "GADMINTARGET", stellarAddress: "GADMINTARGET" }),
    exp: Math.floor(Date.now() / 1000) + 900,
  });
  return `${header}.${forgedPayload}.${signature}`;
}

/** Register a user the way a completed login would, and return a token for it. */
async function tokenForRegisteredUser(
  stellarAddress: string,
  overrides: SignOverrides = {}
): Promise<{ token: string; userId: string }> {
  const user = await userRepository.save({ stellarAddress });
  return {
    token: signToken(
      { stellarAddress, userId: user.id },
      { subject: stellarAddress, ...overrides }
    ),
    userId: user.id,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeAll(() => {
  ({ app, userRepository } = createTestApp());
});

describe("JWT validation: accepted tokens", () => {
  it("returns the current user for a valid token", async () => {
    const address = "GVALIDUSER0001";
    const { token, userId } = await tokenForRegisteredUser(address);

    const response = await getMe(`Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ id: userId, stellarAddress: address });
  });

  it("authenticates from the sub claim alone, without the optional claims", async () => {
    const address = "GSUBONLY0001";
    await userRepository.save({ stellarAddress: address });

    const response = await getMe(`Bearer ${signToken({ sub: address })}`);

    expect(response.status).toBe(200);
    expect(response.body.user.stellarAddress).toBe(address);
  });

  it("accepts a token that is close to, but not past, its expiry", async () => {
    const { token } = await tokenForRegisteredUser("GNEAREXPIRY001", { expiresIn: "30s" });

    const response = await getMe(`Bearer ${token}`);

    expect(response.status).toBe(200);
  });

  it("accepts a long-lived token for a registered user", async () => {
    const { token } = await tokenForRegisteredUser("GLONGLIVED0001", { expiresIn: "365d" });

    const response = await getMe(`Bearer ${token}`);

    expect(response.status).toBe(200);
  });
});

describe("JWT validation: rejects invalid tokens with a 401 envelope", () => {
  // [label, tokenFactory, expectedMessage]
  const cases: Array<[string, () => string, string]> = [
    [
      "a token signed with an unknown secret key",
      () => signToken(claims(), { secret: "invalid-secret-key" }),
      INVALID_TOKEN_MESSAGE,
    ],
    [
      "a token signed with a different HS256 secret",
      () => signToken(claims(), { secret: "completely-different-secret", algorithm: "HS256" }),
      INVALID_TOKEN_MESSAGE,
    ],
    ["an expired token", () => signToken(claims(), { expiresIn: "-5m" }), INVALID_TOKEN_MESSAGE],
    [
      "a token that is not yet valid (nbf in the future)",
      () => signToken(claims(), { notBefore: "1h" }),
      INVALID_TOKEN_MESSAGE,
    ],
    [
      "a token signed with the 'none' algorithm",
      () => signToken(claims(), { secret: "", algorithm: "none" }),
      INVALID_TOKEN_MESSAGE,
    ],
    ["a completely random non-JWT string", () => "not-a-jwt-at-all", INVALID_TOKEN_MESSAGE],
    ["a token missing its signature segment", twoSegmentToken, INVALID_TOKEN_MESSAGE],
    [
      "a token carrying an undecodable base64url payload",
      undecodablePayloadToken,
      INVALID_TOKEN_MESSAGE,
    ],
    [
      "a token signed over a valid-looking payload with the wrong key",
      wrongKeySignatureToken,
      INVALID_TOKEN_MESSAGE,
    ],
    [
      "a token whose payload was tampered with after signing",
      tamperedPayloadToken,
      INVALID_TOKEN_MESSAGE,
    ],
    [
      "a verified token missing the sub claim",
      () => signToken({ stellarAddress: "GNOSUBCLAIM", userId: crypto.randomUUID() }),
      INVALID_PAYLOAD_MESSAGE,
    ],
    [
      "a verified token carrying an empty sub claim",
      () => signToken(claims({ sub: "", stellarAddress: "" })),
      INVALID_PAYLOAD_MESSAGE,
    ],
    [
      "a verified token carrying a non-string sub claim",
      () => signToken(claims({ sub: 12345 })),
      UNKNOWN_USER_MESSAGE,
    ],
    [
      "a well-formed token for a user that does not exist",
      () =>
        signToken(
          claims({ sub: "GNONEXISTENTUSERADDRESS", stellarAddress: "GNONEXISTENTUSERADDRESS" })
        ),
      UNKNOWN_USER_MESSAGE,
    ],
    [
      "a long-lived token for a user that does not exist",
      () =>
        signToken(claims({ sub: "GLONGVALIDTOKEN", stellarAddress: "GLONGVALIDTOKEN" }), {
          expiresIn: "365d",
        }),
      UNKNOWN_USER_MESSAGE,
    ],
  ];

  it.each(cases)("rejects %s", async (_label, makeToken, expectedMessage) => {
    const token = makeToken();
    const response = await getMe(`Bearer ${token}`);
    expectRejected(response, expectedMessage, token);
  });

  it("rejects an expired token even when its user exists", async () => {
    const { token } = await tokenForRegisteredUser("GEXPIREDUSER001", { expiresIn: "-1m" });

    expectRejected(await getMe(`Bearer ${token}`), INVALID_TOKEN_MESSAGE, token);
  });
});

describe("JWT validation: Authorization header handling", () => {
  it("rejects a request with no Authorization header", async () => {
    expectRejected(await getMe(), MISSING_TOKEN_MESSAGE);
  });

  it.each([
    ["an empty Bearer credential", "Bearer "],
    ["a bare scheme with no credential", "Bearer"],
    ["a non-Bearer scheme", "Basic dXNlcjpwYXNzd29yZA=="],
    ["a credential without a scheme", "some-token-without-a-scheme"],
  ])("rejects %s as a missing token", async (_label, header) => {
    expectRejected(await getMe(header), MISSING_TOKEN_MESSAGE);
  });

  it("does not read the token from the query string", async () => {
    const { token } = await tokenForRegisteredUser("GQUERYSTRING001");

    const response = await request(app).get(`${ME_PATH}?token=${token}`);

    expectRejected(response, MISSING_TOKEN_MESSAGE);
  });

  it("rejects a token longer than the maximum bearer length before verifying it", async () => {
    const oversized = "a".repeat(MAX_BEARER_TOKEN_LENGTH + 1);

    expectRejected(await getMe(`Bearer ${oversized}`), INVALID_TOKEN_MESSAGE, oversized);
  });

  it.each(["bearer", "BEARER", "Bearer"])(
    "matches the %s scheme case-insensitively (RFC 7235)",
    async (scheme) => {
      const { token } = await tokenForRegisteredUser(`GSCHEME${scheme}`.slice(0, 20));

      const response = await getMe(`${scheme} ${token}`);

      expect(response.status).toBe(200);
    }
  );

  it("ignores extra whitespace around the credential", async () => {
    const { token } = await tokenForRegisteredUser("GPADDEDCREDENTIAL");

    const response = await getMe(`Bearer    ${token}   `);

    expect(response.status).toBe(200);
  });

  it("still verifies the token when the scheme is lowercase", async () => {
    const token = signToken(
      claims({ sub: "GLOWERCASEUNKNOWN", stellarAddress: "GLOWERCASEUNKNOWN" })
    );

    expectRejected(await getMe(`bearer ${token}`), UNKNOWN_USER_MESSAGE, token);
  });
});

describe("JWT validation: error response contract", () => {
  it("uses the same envelope for a missing header and a forged token", async () => {
    const forged = signToken(claims(), { secret: "wrong-secret" });

    const [missing, invalid] = await Promise.all([getMe(), getMe(`Bearer ${forged}`)]);

    expectRejected(missing, MISSING_TOKEN_MESSAGE);
    expectRejected(invalid, INVALID_TOKEN_MESSAGE, forged);
    expect(Object.keys(missing.body).sort()).toEqual(Object.keys(invalid.body).sort());
    expect(Object.keys(missing.body.error).sort()).toEqual(Object.keys(invalid.body.error).sort());
  });

  it("never leaks stack traces or the signing secret in a rejection", async () => {
    const response = await getMe(`Bearer ${signToken(claims(), { secret: "wrong" })}`);
    const serialized = JSON.stringify(response.body);

    expect(serialized).not.toContain(VALID_JWT_SECRET);
    expect(serialized).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
    expect(response.body.error).not.toHaveProperty("stack");
  });

  it("always answers 401 (never 403 or 500) across a sample of invalid tokens", async () => {
    const tokens = [
      signToken(claims(), { secret: "wrong" }),
      signToken(claims(), { expiresIn: "-1m" }),
      signToken(claims(), { notBefore: "1h" }),
      "not-a-jwt",
    ];

    for (const token of tokens) {
      const response = await getMe(`Bearer ${token}`);
      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    }
  });

  it("answers 500, not 401, when the user lookup fails, so valid sessions are not discarded", async () => {
    const { token } = await tokenForRegisteredUser("GLOOKUPFAILURE01");
    const spy = jest
      .spyOn(userRepository, "findByStellarAddress")
      .mockRejectedValueOnce(new Error("connection reset"));

    try {
      const response = await getMe(`Bearer ${token}`);

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(JSON.stringify(response.body)).not.toContain("connection reset");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("JWT validation: concurrency", () => {
  it("validates many concurrent requests independently", async () => {
    const { token } = await tokenForRegisteredUser("GCONCURRENT0001");
    const forged = signToken(claims(), { secret: "wrong" });

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => getMe(`Bearer ${i % 2 === 0 ? token : forged}`))
    );

    responses.forEach((response, i) => {
      if (i % 2 === 0) {
        expect(response.status).toBe(200);
      } else {
        expectRejected(response, INVALID_TOKEN_MESSAGE, forged);
      }
    });
  });
});
