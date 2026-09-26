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
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createTestApp();
  });

  it("rejects GET /api/v1/auth/me when the JWT is signed with an invalid secret key", async () => {
    try {
      const forgedToken = jwt.sign(
        {
          sub: "GFORGED_STELLAR_ADDRESS",
          stellarAddress: "GFORGED_STELLAR_ADDRESS",
          userId: crypto.randomUUID(),
        },
        "invalid-secret-key",
        { expiresIn: "15m" }
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
    } catch (error) {
      throw new Error(
        `JWT validation test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  it("rejects GET /api/v1/auth/me with expired JWT token", async () => {
    try {
      const expiredToken = jwt.sign(
        {
          sub: "GEXPIRED_STELLAR_ADDRESS",
          stellarAddress: "GEXPIRED_STELLAR_ADDRESS",
          userId: crypto.randomUUID(),
        },
        VALID_JWT_SECRET,
        { expiresIn: "-5m" }
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
    } catch (error) {
      throw new Error(
        `Expired token test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  it("returns 401 from /me when the bearer token is missing", async () => {
    try {
      const response = await request(app).get("/api/v1/auth/me").expect(401);

      expect(response.body).toMatchObject({
        success: false,
        error: {
          message: "Authorization token is required.",
        },
      });
    } catch (error) {
      throw new Error(
        `Missing token test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// JWT validation: malformed tokens
// ═══════════════════════════════════════════════════════════════════════════

describe("JWT validation: malformed tokens", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createTestApp();
  });

  it("rejects a completely random non-JWT string", async () => {
    try {
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
    } catch (error) {
      throw new Error(
        `Malformed token test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  it("rejects a token with only two parts (missing signature)", async () => {
    try {
      // A valid JWT has three base64url parts separated by dots.
      // Create one with only header.payload (no signature).
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
        "base64url"
      );
      const payload = Buffer.from(
        JSON.stringify({ sub: "GTESTADDRESS", stellarAddress: "GTESTADDRESS" })
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
    } catch (error) {
      throw new Error(
        `Two-part token test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  it("rejects an empty string as token", async () => {
    try {
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
    } catch (error) {
      throw new Error(
        `Empty token test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  it("rejects a token with invalid base64url encoding in payload", async () => {
    try {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
        "base64url"
      );
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
    } catch (error) {
      throw new Error(
        `Invalid base64 test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// JWT validation: algorithm and signing attacks
// ═══════════════════════════════════════════════════════════════════════════

describe("JWT validation: algorithm and signing attacks", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createTestApp();
  });

  it("rejects a token signed with 'none' algorithm", async () => {
    try {
      const unsignedToken = jwt.sign(
        {
          sub: "GNONEALGADDRESS",
          stellarAddress: "GNONEALGADDRESS",
          userId: crypto.randomUUID(),
        },
        "",
        { algorithm: "none", expiresIn: "15m" }
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
    } catch (error) {
      throw new Error(
        `Algorithm attack test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  it("rejects a token signed with a different HS256 secret", async () => {
    try {
      const token = jwt.sign(
        {
          sub: "GDIFFERENT_SECRET_ADDR",
          stellarAddress: "GDIFFERENT_SECRET_ADDR",
          userId: crypto.randomUUID(),
        },
        "completely-different-secret",
        { algorithm: "HS256", expiresIn: "15m" }
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
    } catch (error) {
      throw new Error(
        `Different secret test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  it("rejects a token where the header is tampered to use HS256 but was originally signed with a different key", async () => {
    try {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
        "base64url"
      );
      const payload = Buffer.from(
        JSON.stringify({
          sub: "GTAMPEREDADDR",
          stellarAddress: "GTAMPEREDADDR",
          userId: crypto.randomUUID(),
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 900,
        })
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
    } catch (error) {
      throw new Error(
        `Tampering test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// JWT validation: missing or invalid claims
// ═══════════════════════════════════════════════════════════════════════════

describe("JWT validation: missing or invalid claims", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createTestApp();
  });

  it("rejects a token with no sub claim", async () => {
    try {
      const token = jwt.sign(
        {
          stellarAddress: "GNOSUBCLAIM",
          userId: crypto.randomUUID(),
        },
        VALID_JWT_SECRET,
        { expiresIn: "15m" }
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
    } catch (error) {
      throw new Error(
        `Claims validation test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  it("rejects a token with an empty sub claim", async () => {
    try {
      const token = jwt.sign(
        {
          sub: "",
          stellarAddress: "",
          userId: crypto.randomUUID(),
        },
        VALID_JWT_SECRET,
        { expiresIn: "15m" }
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
    } catch (error) {
      throw new Error(
        `Empty sub test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  it("rejects a valid JWT for a user that does not exist in the repository", async () => {
    try {
      const token = jwt.sign(
        {
          sub: "GNONEXISTENTUSERADDRESS",
          stellarAddress: "GNONEXISTENTUSERADDRESS",
          userId: crypto.randomUUID(),
        },
        VALID_JWT_SECRET,
        { expiresIn: "15m" }
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
    } catch (error) {
      throw new Error(
        `Nonexistent user test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  it("rejects a token with sub set to a non-string value", async () => {
    try {
      const token = jwt.sign(
        {
          sub: 12345,
          stellarAddress: "GNOTASTRING",
          userId: crypto.randomUUID(),
        },
        VALID_JWT_SECRET,
        { expiresIn: "15m" }
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
    } catch (error) {
      throw new Error(
        `Non-string sub test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// JWT validation: Authorization header edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("JWT validation: Authorization header edge cases", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createTestApp();
  });

  it("rejects request with lowercase 'bearer' prefix", async () => {
    try {
      const token = jwt.sign(
        {
          sub: "GLOWERCASEBEARER",
          stellarAddress: "GLOWERCASEBEARER",
          userId: crypto.randomUUID(),
        },
        VALID_JWT_SECRET,
        { expiresIn: "15m" }
      );

      const response = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `bearer ${token}`)
        .expect(401);

      expect(response.body).toMatchObject({
        success: false,
        error: {
          message: expect.stringMatching(
            /Authorization token is required\.|Invalid or expired token\./
          ),
        },
      });
    } catch (error) {
      throw new Error(
        `Bearer prefix test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  it("rejects (401) a Bearer value padded with surrounding whitespace", async () => {
    try {
      const token = jwt.sign(
        {
          sub: "GPADDEDWHITESPACE",
          stellarAddress: "GPADDEDWHITESPACE",
          userId: crypto.randomUUID(),
        },
        VALID_JWT_SECRET,
        { expiresIn: "15m" }
      );

      const response = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer   ${token}   `);

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    } catch (error) {
      throw new Error(
        `Whitespace padding test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// JWT validation: error response structure
// ═══════════════════════════════════════════════════════════════════════════

describe("JWT validation: error response structure", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createTestApp();
  });

  it("returns consistent error envelope on forged token", async () => {
    try {
      const forgedToken = jwt.sign(
        {
          sub: "GSTRUCTTEST1",
          stellarAddress: "GSTRUCTTEST1",
        },
        "wrong-secret",
        { expiresIn: "15m" }
      );

      const response = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${forgedToken}`)
        .expect(401);

      expect(response.body).toHaveProperty("success", false);
      expect(response.body).toHaveProperty("error");
      expect(response.body.error).toHaveProperty("message");
      expect(typeof response.body.error.message).toBe("string");
    } catch (error) {
      throw new Error(
        `Error envelope test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  it("uses the same envelope when no Authorization header is sent", async () => {
    try {
      const response = await request(app).get("/api/v1/auth/me").expect(401);

      expect(response.body).toHaveProperty("success", false);
      expect(response.body).toHaveProperty("error");
      expect(response.body.error).toHaveProperty("message");
    } catch (error) {
      throw new Error(
        `No auth header test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  it("always answers 401 (never 403 or 500) across a sample of invalid tokens", async () => {
    try {
      const tokens = [
        jwt.sign({ sub: "GUSER1" }, "wrong-secret", { expiresIn: "15m" }),
        jwt.sign({ sub: "GUSER1" }, VALID_JWT_SECRET, { expiresIn: "-1m" }),
        "not-a-jwt",
      ];

      for (const token of tokens) {
        const response = await request(app)
          .get("/api/v1/auth/me")
          .set("Authorization", `Bearer ${token}`);

        expect(response.status).toBe(401);
        expect(response.body.success).toBe(false);
      }
    } catch (error) {
      throw new Error(
        `Status codes test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// JWT validation: token with future nbf (not yet valid)
// ═══════════════════════════════════════════════════════════════════════════

describe("JWT validation: token timing edge cases", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createTestApp();
  });

  it("rejects a token with nbf set far in the future", async () => {
    try {
      const futureToken = jwt.sign(
        {
          sub: "GFUTURETOKEN",
          stellarAddress: "GFUTURETOKEN",
          userId: crypto.randomUUID(),
        },
        VALID_JWT_SECRET,
        { expiresIn: "15m", notBefore: "1h" }
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
    } catch (error) {
      throw new Error(
        `Future token test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  it("accepts a token with iat set to now and exp set to far future", async () => {
    try {
      // This token is valid for a very long time
      const validToken = jwt.sign(
        {
          sub: "GLONGVALIDTOKEN",
          stellarAddress: "GLONGVALIDTOKEN",
          userId: crypto.randomUUID(),
        },
        VALID_JWT_SECRET,
        { expiresIn: "365d" }
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
    } catch (error) {
      throw new Error(
        `Long-lived token test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
});
