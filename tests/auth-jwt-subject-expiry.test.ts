import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { AuthService } from "../src/services/auth.service";
import type {
  ChallengeRepositoryContract,
  UserRepositoryContract,
} from "../src/services/auth.service";
import { KYCStatus, UserType } from "../src/types/enums";
import { HttpError } from "../src/utils/http-error";

// Import app for full integration test
import request from "supertest";
import { createApp } from "../src/app";

// ── In-memory repositories ──

import { User } from "../src/models/User.model";

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
      isSuspended: user.isSuspended ?? false,
      suspendedAt: user.suspendedAt ?? null,
      suspensionReason: user.suspensionReason ?? null,
      createdAt: user.createdAt ?? now,
      updatedAt: user.updatedAt ?? now,
      deletedAt: user.deletedAt ?? null,
      invoices: user.invoices ?? [],
      investments: user.investments ?? [],
      transactions: user.transactions ?? [],
      kycVerifications: user.kycVerifications ?? [],
      notifications: user.notifications ?? [],
      kycHistory: user.kycHistory ?? [],
      secondaryListings: user.secondaryListings ?? [],
      watchlistEntries: user.watchlistEntries ?? [],
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

// ── Helpers ──

const TEST_SECRET = "test-secret-for-jwt-tests";

function createAuthServiceWithTtl(ttlString: string, challengeTtlMs = 60_000): AuthService {
  return new AuthService({
    userRepository: new InMemoryUserRepository(),
    challengeRepository: new InMemoryChallengeRepository(),
    config: {
      jwt: {
        secret: TEST_SECRET,
        expiresIn: ttlString,
      },
      auth: {
        challengeTtlMs,
      },
      stellar: {
        network: "testnet",
        networkPassphrase: Networks.TESTNET,
      },
    },
  });
}

function createTestApp(ttlString = "15m") {
  const userRepository = new InMemoryUserRepository();
  const challengeRepository = new InMemoryChallengeRepository();
  const authService = new AuthService({
    userRepository,
    challengeRepository,
    config: {
      jwt: {
        secret: TEST_SECRET,
        expiresIn: ttlString,
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

  return {
    app: createApp({ authService }),
    challengeRepository,
    authService,
  };
}

// ── Unit Tests ──

describe("JWT subject claim", () => {
  it("should have sub equal to the wallet address used in the challenge", async () => {
    const { app } = createTestApp();
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();

    const challengeRes = await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: walletAddress })
      .expect(201);

    const { nonce, message } = challengeRes.body.challenge;
    const signature = keypair.sign(Buffer.from(message, "utf8")).toString("base64");

    const verifyRes = await request(app)
      .post("/api/v1/auth/verify")
      .send({
        publicKey: walletAddress,
        nonce,
        signature,
      })
      .expect(200);

    const token = verifyRes.body.token;

    const decoded = jwt.decode(token) as jwt.JwtPayload;
    expect(decoded).not.toBeNull();
    expect(decoded!.sub).toBe(walletAddress);
  });
});

describe("JWT expiry", () => {
  it("should be within 1 second of now + configured TTL", async () => {
    const { app } = createTestApp("1h");
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();

    const challengeRes = await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: walletAddress })
      .expect(201);

    const { nonce, message } = challengeRes.body.challenge;
    const signature = keypair.sign(Buffer.from(message, "utf8")).toString("base64");

    const verifyRes = await request(app)
      .post("/api/v1/auth/verify")
      .send({
        publicKey: walletAddress,
        nonce,
        signature,
      })
      .expect(200);

    const token = verifyRes.body.token;

    const decoded = jwt.decode(token) as jwt.JwtPayload;
    expect(decoded).not.toBeNull();
    expect(decoded!.exp).toBeDefined();

    const now = Math.floor(Date.now() / 1000);
    const expectedExp = now + 3600;

    expect(Math.abs(decoded!.exp! - expectedExp)).toBeLessThanOrEqual(1);
  });
});

describe("Tampered JWT", () => {
  it("should be rejected with 401 by the verification middleware", async () => {
    const { app } = createTestApp();
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();

    const challengeRes = await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: walletAddress })
      .expect(201);

    const { nonce, message } = challengeRes.body.challenge;
    const signature = keypair.sign(Buffer.from(message, "utf8")).toString("base64");

    const verifyRes = await request(app)
      .post("/api/v1/auth/verify")
      .send({
        publicKey: walletAddress,
        nonce,
        signature,
      })
      .expect(200);

    const validToken = verifyRes.body.token;

    const parts = validToken.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        sub: "tampered-wallet",
        stellarAddress: "tampered",
        iat: 0,
        exp: 9999999999,
      })
    ).toString("base64url");
    const tamperedToken = [parts[0], tamperedPayload, parts[2]].join(".");

    await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${tamperedToken}`)
      .expect(401);
  });
});

describe("Expired JWT", () => {
  it("should be rejected with 401 when TTL is set to -1s in test config", async () => {
    const { app } = createTestApp("-1s");
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();

    const challengeRes = await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: walletAddress })
      .expect(201);

    const { nonce, message } = challengeRes.body.challenge;
    const signature = keypair.sign(Buffer.from(message, "utf8")).toString("base64");

    const verifyRes = await request(app)
      .post("/api/v1/auth/verify")
      .send({
        publicKey: walletAddress,
        nonce,
        signature,
      })
      .expect(200);

    const expiredToken = verifyRes.body.token;

    await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${expiredToken}`)
      .expect(401);
  });
});

describe("Wallet-Bound JWT Claims & Negative Test Matrix (#56)", () => {
  it("should reject a token with a malformed wallet address format in sub/wallet", async () => {
    const { app } = createTestApp();
    
    const malformedToken = jwt.sign(
      {
        sub: "INVALID_STELLAR_OR_EVM_ADDRESS",
        wallet: "INVALID_STELLAR_OR_EVM_ADDRESS",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      TEST_SECRET
    );

    await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${malformedToken}`)
      .expect(401);
  });

  it("should reject a token with missing required claims", async () => {
    const { app } = createTestApp();
    
    const incompleteToken = jwt.sign(
      {
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      TEST_SECRET
    );

    await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${incompleteToken}`)
      .expect(401);
  });

  it("should allow public/unauthenticated routes to remain accessible without tokens", async () => {
    const { app } = createTestApp();

    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();

    await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: walletAddress })
      .expect(201);
  });
});
