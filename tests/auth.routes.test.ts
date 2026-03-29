import crypto from "crypto";
import request from "supertest";
import { Keypair, Networks } from "stellar-sdk";
import { createApp } from "../src/app";
import { User } from "../src/models/User.model";
import { AuthService } from "../src/services/auth.service";
import type {
  ChallengeRepositoryContract,
  UserRepositoryContract,
} from "../src/services/auth.service";
import { KYCStatus, UserType } from "../src/types/enums";

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
      [...this.users.values()].find((user) => user.stellarAddress === stellarAddress) ??
      null
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

function createTestServer() {
  const userRepository = new InMemoryUserRepository();
  const challengeRepository = new InMemoryChallengeRepository();
  const authService = new AuthService({
    userRepository,
    challengeRepository,
    config: {
      jwt: {
        secret: "test-secret",
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

  return {
    app: createApp({ authService }),
    challengeRepository,
  };
}

describe("Auth routes", () => {
  it("creates a JWT session and resolves /me for a valid Stellar signature", async () => {
    const { app } = createTestServer();
    const keypair = Keypair.random();

    const challengeResponse = await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: keypair.publicKey() })
      .expect(201);

    const { nonce, message, network } = challengeResponse.body.challenge;

    expect(nonce).toEqual(expect.any(String));
    expect(message).toContain(keypair.publicKey());
    expect(network).toBe("testnet");

    const signature = keypair.sign(Buffer.from(message, "utf8")).toString("base64");

    const verifyResponse = await request(app)
      .post("/api/v1/auth/verify")
      .send({
        publicKey: keypair.publicKey(),
        nonce,
        signature,
      })
      .expect(200);

    expect(verifyResponse.body.token).toEqual(expect.any(String));
    expect(verifyResponse.body.user.stellarAddress).toBe(keypair.publicKey());
    expect(verifyResponse.body.expiresIn).toBe("15m");

    const meResponse = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${verifyResponse.body.token}`)
      .expect(200);

    expect(meResponse.body.user.stellarAddress).toBe(keypair.publicKey());
  });

  it("rejects invalid signatures and reused nonces", async () => {
    const { app, challengeRepository } = createTestServer();
    const keypair = Keypair.random();

    const challengeResponse = await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: keypair.publicKey() })
      .expect(201);

    const { nonce, message } = challengeResponse.body.challenge;
    const validSignature = keypair.sign(Buffer.from(message, "utf8")).toString("base64");

    await request(app)
      .post("/api/v1/auth/verify")
      .send({
        publicKey: keypair.publicKey(),
        nonce,
        signature: "not-a-valid-signature",
      })
      .expect(401);

    await request(app)
      .post("/api/v1/auth/verify")
      .send({
        publicKey: keypair.publicKey(),
        nonce,
        signature: validSignature,
      })
      .expect(200);

    await request(app)
      .post("/api/v1/auth/verify")
      .send({
        publicKey: keypair.publicKey(),
        nonce,
        signature: validSignature,
      })
      .expect(401);

    expect(
      [...challengeRepository.challenges.values()].some(
        (challenge) => challenge.consumedAt !== null,
      ),
    ).toBe(true);
  });

  it("returns 401 from /me when the bearer token is missing", async () => {
    const { app } = createTestServer();

    const response = await request(app).get("/api/v1/auth/me").expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Authorization token is required.",
      },
    });
  });
});