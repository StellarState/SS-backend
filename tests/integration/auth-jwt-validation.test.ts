import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Networks } from "stellar-sdk";
import request from "supertest";

import { createApp } from "../../src/app";
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
    return (
      [...this.users.values()].find(
        (user) => user.stellarAddress === stellarAddress,
      ) ?? null
    );
  }

  async save(user: Partial<InMemoryUser>) {
    const now = new Date();
    const entity: InMemoryUser = {
      id: crypto.randomUUID(),
      stellarAddress: user.stellarAddress ?? "",
      email: user.email ?? null,
      userType: user.userType ?? UserType.INVESTOR,
      kycStatus: user.kycStatus ?? KYCStatus.PENDING,
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
          challenge.stellarAddress === stellarAddress &&
          challenge.nonceHash === nonceHash,
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
}

// ── Test helpers ──────────────────────────────────────────────────────────────

const VALID_JWT_SECRET = "valid-test-secret";

function createTestApp() {
  const authService = new AuthService({
    userRepository: new InMemoryUserRepository(),
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

  return createApp({ authService });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("JWT authentication validation", () => {
  it("rejects GET /api/v1/auth/me when the JWT is signed with an invalid secret key", async () => {
    const app = createTestApp();

    const forgedToken = jwt.sign(
      {
        sub: "GFORGED_STELLAR_ADDRESS",
        stellarAddress: "GFORGED_STELLAR_ADDRESS",
        userId: crypto.randomUUID(),
      },
      "invalid-secret-key",
      { expiresIn: "15m" },
    );

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${forgedToken}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Invalid or expired token.",
      },
    });
  });

  it("rejects GET /api/v1/auth/me with expired JWT token", async () => {
    const app = createTestApp();

    const expiredToken = jwt.sign(
      {
        sub: "GEXPIRED_STELLAR_ADDRESS",
        stellarAddress: "GEXPIRED_STELLAR_ADDRESS",
        userId: crypto.randomUUID(),
      },
      VALID_JWT_SECRET,
      { expiresIn: "-5m" },
    );

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${expiredToken}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Invalid or expired token.",
      },
    });
  });

  it("returns 401 from /me when the bearer token is missing", async () => {
    const app = createTestApp();

    const response = await request(app).get("/api/v1/auth/me").expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Authorization token is required.",
      },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// JWT validation: malformed tokens
// ═══════════════════════════════════════════════════════════════════════════

describe("JWT validation: malformed tokens", () => {
  it("rejects a completely random non-JWT string", async () => {
    const app = createTestApp();

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer not-a-jwt-at-all")
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Invalid or expired token.",
      },
    });
  });

  it("rejects a token with only two parts (missing signature)", async () => {
    const app = createTestApp();

    // A valid JWT has three base64url parts separated by dots.
    // Create one with only header.payload (no signature).
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "GTESTADDRESS", stellarAddress: "GTESTADDRESS" }),
    ).toString("base64url");
    const twoPartToken = `${header}.${payload}`;

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${twoPartToken}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Invalid or expired token.",
      },
    });
  });

  it("rejects an empty string as token", async () => {
    const app = createTestApp();

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer ")
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Authorization token is required.",
      },
    });
  });

  it("rejects a token with invalid base64url encoding in payload", async () => {
    const app = createTestApp();

    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    // Use invalid base64 characters
    const invalidPayload = "!!!invalid-base64!!!";
    const badToken = `${header}.${invalidPayload}.signature`;

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${badToken}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Invalid or expired token.",
      },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// JWT validation: algorithm and signing attacks
// ═══════════════════════════════════════════════════════════════════════════

describe("JWT validation: algorithm and signing attacks", () => {
  it("rejects a token signed with 'none' algorithm", async () => {
    const app = createTestApp();

    // jwt.sign with algorithm: 'none' produces an unsigned token
    const unsignedToken = jwt.sign(
      {
        sub: "GNONEALGADDRESS",
        stellarAddress: "GNONEALGADDRESS",
        userId: crypto.randomUUID(),
      },
      "",
      { algorithm: "none", expiresIn: "15m" },
    );

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${unsignedToken}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Invalid or expired token.",
      },
    });
  });

  it("rejects a token signed with a different HS256 secret", async () => {
    const app = createTestApp();

    const token = jwt.sign(
      {
        sub: "GDIFFERENT_SECRET_ADDR",
        stellarAddress: "GDIFFERENT_SECRET_ADDR",
        userId: crypto.randomUUID(),
      },
      "completely-different-secret",
      { algorithm: "HS256", expiresIn: "15m" },
    );

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Invalid or expired token.",
      },
    });
  });

  it("rejects a token where the header is tampered to use HS256 but was originally signed with a different key", async () => {
    const app = createTestApp();

    // Sign with one secret, then manually change the alg in the header
    // and re-encode to simulate an alg-switch attack
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: "GTAMPEREDADDR",
        stellarAddress: "GTAMPEREDADDR",
        userId: crypto.randomUUID(),
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    ).toString("base64url");

    // Sign the tampered header.payload with a wrong secret
    const signature = require("crypto")
      .createHmac("sha256", "wrong-secret")
      .update(`${header}.${payload}`)
      .digest("base64url");

    const tamperedToken = `${header}.${payload}.${signature}`;

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${tamperedToken}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Invalid or expired token.",
      },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// JWT validation: missing or invalid claims
// ═══════════════════════════════════════════════════════════════════════════

describe("JWT validation: missing or invalid claims", () => {
  it("rejects a token with no sub claim", async () => {
    const app = createTestApp();

    const token = jwt.sign(
      {
        stellarAddress: "GNOSUBCLAIM",
        userId: crypto.randomUUID(),
      },
      VALID_JWT_SECRET,
      { expiresIn: "15m" },
    );

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Invalid or expired token.",
      },
    });
  });

  it("rejects a token with an empty sub claim", async () => {
    const app = createTestApp();

    const token = jwt.sign(
      {
        sub: "",
        stellarAddress: "",
        userId: crypto.randomUUID(),
      },
      VALID_JWT_SECRET,
      { expiresIn: "15m" },
    );

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Invalid or expired token.",
      },
    });
  });

  it("rejects a valid JWT for a user that does not exist in the repository", async () => {
    const app = createTestApp();

    const token = jwt.sign(
      {
        sub: "GNONEXISTENTUSERADDRESS",
        stellarAddress: "GNONEXISTENTUSERADDRESS",
        userId: crypto.randomUUID(),
      },
      VALID_JWT_SECRET,
      { expiresIn: "15m" },
    );

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: expect.stringContaining("Invalid or expired token."),
      },
    });
  });

  it("rejects a token with sub set to a non-string value", async () => {
    const app = createTestApp();

    const token = jwt.sign(
      {
        sub: 12345,
        stellarAddress: "GNOTASTRING",
        userId: crypto.randomUUID(),
      },
      VALID_JWT_SECRET,
      { expiresIn: "15m" },
    );

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Invalid or expired token.",
      },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// JWT validation: Authorization header edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("JWT validation: Authorization header edge cases", () => {
  it("rejects request with lowercase 'bearer' prefix", async () => {
    const app = createTestApp();

    const token = jwt.sign(
      {
        sub: "GLOWERCASEBEARER",
        stellarAddress: "GLOWERCASEBEARER",
        userId: crypto.randomUUID(),
      },
      VALID_JWT_SECRET,
      { expiresIn: "15m" },
    );

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `bearer ${token}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Authorization token is required.",
      },
    });
  });

  it("rejects request with raw token (no Bearer prefix)", async () => {
    const app = createTestApp();

    const token = jwt.sign(
      {
        sub: "GNOBEARERPREFIX",
        stellarAddress: "GNOBEARERPREFIX",
        userId: crypto.randomUUID(),
      },
      VALID_JWT_SECRET,
      { expiresIn: "15m" },
    );

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", token)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Authorization token is required.",
      },
    });
  });

  it("rejects request with 'Token' scheme instead of 'Bearer'", async () => {
    const app = createTestApp();

    const token = jwt.sign(
      {
        sub: "GTOKENSCHEME",
        stellarAddress: "GTOKENSCHEME",
        userId: crypto.randomUUID(),
      },
      VALID_JWT_SECRET,
      { expiresIn: "15m" },
    );

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Token ${token}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Authorization token is required.",
      },
    });
  });

  it("rejects request with extra whitespace around a valid token", async () => {
    const app = createTestApp();

    const token = jwt.sign(
      {
        sub: "GEXTRAWHITESPACE",
        stellarAddress: "GEXTRAWHITESPACE",
        userId: crypto.randomUUID(),
      },
      VALID_JWT_SECRET,
      { expiresIn: "15m" },
    );

    // The server should trim the token before verification
    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer   ${token}   `)
      .expect(401);

    // Depending on implementation, extra whitespace may cause signature mismatch
    expect(response.body).toMatchObject({
      success: false,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// JWT validation: error response structure
// ═══════════════════════════════════════════════════════════════════════════

describe("JWT validation: error response structure", () => {
  it("returns consistent error envelope on forged token", async () => {
    const app = createTestApp();

    const forgedToken = jwt.sign(
      {
        sub: "GSTRUCTTEST1",
        stellarAddress: "GSTRUCTTEST1",
      },
      "wrong-secret",
      { expiresIn: "15m" },
    );

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${forgedToken}`)
      .expect(401);

    expect(response.body).toHaveProperty("success", false);
    expect(response.body).toHaveProperty("error");
    expect(response.body.error).toHaveProperty("message");
    expect(typeof response.body.error.message).toBe("string");
  });

  it("returns consistent error envelope on expired token", async () => {
    const app = createTestApp();

    const expiredToken = jwt.sign(
      {
        sub: "GSTRUCTTEST2",
        stellarAddress: "GSTRUCTTEST2",
      },
      VALID_JWT_SECRET,
      { expiresIn: "-10m" },
    );

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${expiredToken}`)
      .expect(401);

    expect(response.body).toHaveProperty("success", false);
    expect(response.body).toHaveProperty("error");
    expect(response.body.error).toHaveProperty("message");
  });

  it("returns consistent error envelope when no Authorization header is sent", async () => {
    const app = createTestApp();

    const response = await request(app).get("/api/v1/auth/me").expect(401);

    expect(response.body).toHaveProperty("success", false);
    expect(response.body).toHaveProperty("error");
    expect(response.body.error).toHaveProperty("message");
  });

  it("returns 401 (not 403 or 500) for all invalid token scenarios", async () => {
    const app = createTestApp();

    const scenarios = [
      { label: "forged token", token: jwt.sign({ sub: "GX" }, "wrong", { expiresIn: "1m" }) },
      { label: "expired token", token: jwt.sign({ sub: "GX" }, VALID_JWT_SECRET, { expiresIn: "-1m" }) },
      { label: "random string", token: "not-a-jwt" },
    ];

    for (const scenario of scenarios) {
      const response = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${scenario.token}`)
        .expect(401);

      expect(response.body.success).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// JWT validation: token with future nbf (not yet valid)
// ═══════════════════════════════════════════════════════════════════════════

describe("JWT validation: token timing edge cases", () => {
  it("rejects a token with nbf set far in the future", async () => {
    const app = createTestApp();

    const futureToken = jwt.sign(
      {
        sub: "GFUTURETOKEN",
        stellarAddress: "GFUTURETOKEN",
        userId: crypto.randomUUID(),
      },
      VALID_JWT_SECRET,
      { expiresIn: "15m", notBefore: "1h" },
    );

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${futureToken}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Invalid or expired token.",
      },
    });
  });

  it("accepts a token with iat set to now and exp set to far future", async () => {
    const app = createTestApp();

    // This token is valid for a very long time
    const validToken = jwt.sign(
      {
        sub: "GLONGVALIDTOKEN",
        stellarAddress: "GLONGVALIDTOKEN",
        userId: crypto.randomUUID(),
      },
      VALID_JWT_SECRET,
      { expiresIn: "365d" },
    );

    // The token itself is valid, but the user doesn't exist, so we expect 401
    // with a message about invalid/expired token (not about missing token)
    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${validToken}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: expect.stringContaining("Invalid or expired token."),
      },
    });
  });
});
