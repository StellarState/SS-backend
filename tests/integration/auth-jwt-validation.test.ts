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
