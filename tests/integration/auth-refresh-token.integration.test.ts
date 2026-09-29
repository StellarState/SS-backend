import "reflect-metadata";
import crypto from "crypto";
import request from "supertest";
import { Keypair } from "stellar-sdk";
import { DataSource, getMetadataArgsStorage } from "typeorm";

import { createApp } from "../../src/app";
import { AuthChallenge } from "../../src/models/AuthChallenge.model";
import { Investment } from "../../src/models/Investment.model";
import { Invoice } from "../../src/models/Invoice.model";
import { KYCVerification } from "../../src/models/KYCVerification.model";
import { KycHistory } from "../../src/models/KycHistory.model";
import { Notification } from "../../src/models/Notification.model";
import { RefreshToken } from "../../src/models/RefreshToken.model";
import { SecondaryListing } from "../../src/models/SecondaryListing.model";
import { Watchlist } from "../../src/models/Watchlist.model";
import { Transaction } from "../../src/models/Transaction.model";
import { User } from "../../src/models/User.model";
import { createAuthService } from "../../src/services/auth.service";
import type { AppConfig } from "../../src/config/env";

/**
 * Issue #563: refresh token rotation, reuse detection and logout, exercised
 * through the HTTP API against a real (SQLite) database.
 */

const JWT_SECRET = "test-jwt-secret-key-32-chars-minimum-length";

function patchEntityMetadataForSQLite(): void {
  for (const column of getMetadataArgsStorage().columns) {
    if (column.options.type === "timestamptz") column.options.type = "datetime" as never;
    if (column.options.type === "jsonb") column.options.type = "text" as never;
    if (column.options.type === "enum") column.options.type = "varchar" as never;
  }
}

const sha256 = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

describe("Integration: refresh token rotation (issue #563)", () => {
  let dataSource: DataSource;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    patchEntityMetadataForSQLite();

    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [
        User,
        Invoice,
        Investment,
        AuthChallenge,
        Transaction,
        KYCVerification,
        KycHistory,
        Notification,
        RefreshToken,
        SecondaryListing,
        Watchlist,
      ],
      synchronize: true,
      dropSchema: true,
    });
    await dataSource.initialize();

    const config = {
      jwt: { secret: JWT_SECRET, expiresIn: "15m" },
      auth: { challengeTtlMs: 300_000 },
      stellar: { network: "testnet", networkPassphrase: "Test SDF Network ; September 2015" },
    } as unknown as AppConfig;

    app = createApp({
      authService: createAuthService(dataSource, config),
      metricsEnabled: false,
      http: { rateLimit: { enabled: false } },
    });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  async function login(keypair: Keypair) {
    const challenge = await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: keypair.publicKey() });
    expect(challenge.status).toBe(201);

    const signature = keypair
      .sign(Buffer.from(challenge.body.message, "utf8"))
      .toString("base64");

    const verify = await request(app).post("/api/v1/auth/verify").send({
      publicKey: keypair.publicKey(),
      nonce: challenge.body.nonce,
      signature,
    });
    expect(verify.status).toBe(200);
    return verify.body as { token: string; refreshToken: string; refreshTokenExpiresAt: string };
  }

  const refresh = (refreshToken: unknown) =>
    request(app).post("/api/v1/auth/refresh").send({ refreshToken });

  it("issues a refresh token at login and stores only its hash", async () => {
    const session = await login(Keypair.random());

    expect(typeof session.refreshToken).toBe("string");
    expect(session.refreshToken.length).toBeGreaterThanOrEqual(43);
    expect(new Date(session.refreshTokenExpiresAt).getTime()).toBeGreaterThan(Date.now());

    const repo = dataSource.getRepository(RefreshToken);
    expect(await repo.findOne({ where: { tokenHash: session.refreshToken } })).toBeNull();
    const stored = await repo.findOne({ where: { tokenHash: sha256(session.refreshToken) } });
    expect(stored).not.toBeNull();
    expect(stored!.usedAt).toBeNull();
    expect(stored!.revokedAt).toBeNull();
  });

  it("exchanges a valid refresh token for a new, working token pair", async () => {
    const keypair = Keypair.random();
    const session = await login(keypair);

    const response = await refresh(session.refreshToken);

    expect(response.status).toBe(200);
    expect(response.body.tokenType).toBe("Bearer");
    expect(response.body.refreshToken).not.toBe(session.refreshToken);
    expect(response.body.user.stellarAddress).toBe(keypair.publicKey());

    const me = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${response.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.stellarAddress).toBe(keypair.publicKey());

    // The new token belongs to the same login session and the old one points at it.
    const repo = dataSource.getRepository(RefreshToken);
    const oldRow = await repo.findOneOrFail({ where: { tokenHash: sha256(session.refreshToken) } });
    const newRow = await repo.findOneOrFail({
      where: { tokenHash: sha256(response.body.refreshToken) },
    });
    expect(oldRow.usedAt).not.toBeNull();
    expect(oldRow.replacedById).toBe(newRow.id);
    expect(newRow.sessionId).toBe(oldRow.sessionId);

    // The rotated token keeps working for the next rotation.
    expect((await refresh(response.body.refreshToken)).status).toBe(200);
  });

  it("rejects the old refresh token after rotation", async () => {
    const session = await login(Keypair.random());
    expect((await refresh(session.refreshToken)).status).toBe(200);

    const replay = await refresh(session.refreshToken);

    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("REFRESH_TOKEN_REUSED");
    expect(replay.body.error.details).toEqual({ reloginRequired: true });
  });

  it("revokes every session for the wallet when a used token is presented again", async () => {
    const keypair = Keypair.random();
    const bystander = await login(Keypair.random());
    const phone = await login(keypair);
    const laptop = await login(keypair);

    const rotated = await refresh(phone.refreshToken);
    expect(rotated.status).toBe(200);

    // Someone replays the phone's old token.
    expect((await refresh(phone.refreshToken)).body.error.code).toBe("REFRESH_TOKEN_REUSED");

    // Both of the wallet's sessions are gone, including the freshly rotated token.
    const afterRotation = await refresh(rotated.body.refreshToken);
    expect(afterRotation.status).toBe(401);
    expect(afterRotation.body.error.code).toBe("REFRESH_TOKEN_REVOKED");

    const otherDevice = await refresh(laptop.refreshToken);
    expect(otherDevice.status).toBe(401);
    expect(otherDevice.body.error.code).toBe("REFRESH_TOKEN_REVOKED");

    // Other wallets are untouched.
    expect((await refresh(bystander.refreshToken)).status).toBe(200);
  });

  it("lets only one of two concurrent refreshes with the same token succeed", async () => {
    const session = await login(Keypair.random());

    const results = await Promise.all([
      refresh(session.refreshToken),
      refresh(session.refreshToken),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("revokes the refresh token on logout", async () => {
    const keypair = Keypair.random();
    const session = await login(keypair);
    const otherSession = await login(keypair);

    const logout = await request(app)
      .post("/api/v1/auth/logout")
      .send({ refreshToken: session.refreshToken });
    expect(logout.status).toBe(204);

    const afterLogout = await refresh(session.refreshToken);
    expect(afterLogout.status).toBe(401);
    expect(afterLogout.body.error.code).toBe("REFRESH_TOKEN_REVOKED");

    // Logging out one device does not sign out the others.
    expect((await refresh(otherSession.refreshToken)).status).toBe(200);

    // Logging out twice is harmless.
    const again = await request(app)
      .post("/api/v1/auth/logout")
      .send({ refreshToken: session.refreshToken });
    expect(again.status).toBe(204);
  });

  it("returns 401 with a re-login message for an expired refresh token", async () => {
    const session = await login(Keypair.random());
    await dataSource
      .getRepository(RefreshToken)
      .update({ tokenHash: sha256(session.refreshToken) }, { expiresAt: new Date(Date.now() - 1000) });

    const response = await refresh(session.refreshToken);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("REFRESH_TOKEN_EXPIRED");
    expect(response.body.error.message).toMatch(/log in again/i);
    expect(response.body.error.details).toEqual({ reloginRequired: true });
  });

  it("rejects unknown and missing refresh tokens", async () => {
    const unknown = await refresh(crypto.randomBytes(48).toString("base64url"));
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe("INVALID_REFRESH_TOKEN");

    const missing = await refresh(undefined);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("MISSING_REFRESH_TOKEN");

    const logoutUnknown = await request(app)
      .post("/api/v1/auth/logout")
      .send({ refreshToken: "not-a-real-token" });
    expect(logoutUnknown.status).toBe(401);
  });
});
