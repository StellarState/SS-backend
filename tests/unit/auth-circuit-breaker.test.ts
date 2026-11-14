import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { createAuthRouter } from "../../src/routes/auth.routes";
import { createCircuitBreaker } from "../../src/lib/circuit-breaker";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import type { AuthService } from "../../src/services/auth.service";
import type { AppLogger } from "../../src/observability/logger";
import { AppError } from "../../src/utils/http-error";

function createTestLogger(): AppLogger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as AppLogger;
}

describe("Auth route circuit breaker (#698)", () => {
  const originalRateLimitEnabled = process.env.RATE_LIMIT_ENABLED;

  beforeEach(() => {
    process.env.RATE_LIMIT_ENABLED = "false";
  });

  afterEach(() => {
    if (originalRateLimitEnabled === undefined) {
      delete process.env.RATE_LIMIT_ENABLED;
    } else {
      process.env.RATE_LIMIT_ENABLED = originalRateLimitEnabled;
    }
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function buildAuthTestApp(options?: {
    createChallenge?: jest.Mock;
    verifyChallenge?: jest.Mock;
    withInjectedBreaker?: boolean;
    onResponse?: (res: express.Response) => void;
    onErrorMiddleware?: jest.Mock;
  }) {
    const keypair = Keypair.random();
    const publicKey = keypair.publicKey();

    const createChallenge =
      options?.createChallenge ??
      jest.fn().mockResolvedValue({
        publicKey,
        nonce: "nonce-1234567890abcdef",
        message: "Sign this challenge",
        network: "testnet",
        issuedAt: new Date("2026-11-14T00:00:00.000Z").toISOString(),
        expiresAt: new Date("2026-11-14T00:01:00.000Z").toISOString(),
      });

    const verifyChallenge =
      options?.verifyChallenge ??
      jest.fn().mockResolvedValue({
        token: "signed-jwt-token",
        tokenType: "Bearer",
        expiresIn: "15m",
        user: {
          id: "user-1",
          stellarAddress: publicKey,
        },
      });

    const authService = {
      createChallenge,
      verifyChallenge,
      getCurrentUser: jest.fn(),
    } as unknown as AuthService;

    const logger = createTestLogger();
    const breaker =
      options?.withInjectedBreaker === false
        ? undefined
        : createCircuitBreaker({ failureThreshold: 5, timeout: 30000 });

    const app = express();
    app.use(express.json());

    if (options?.onResponse) {
      const hook = options.onResponse;
      app.use((_req, res, next) => {
        hook(res);
        next();
      });
    }

    app.use(
      "/auth",
      breaker
        ? createAuthRouter(authService, logger, { circuitBreaker: breaker })
        : createAuthRouter(authService, logger)
    );

    const baseErrorMiddleware = createErrorMiddleware(logger);
    const errorMiddleware: ErrorRequestHandler = (err, req, res, next) => {
      options?.onErrorMiddleware?.(err);
      baseErrorMiddleware(err, req, res, next);
    };
    app.use(errorMiddleware);

    return {
      app,
      breaker,
      logger,
      publicKey,
      createChallenge,
      verifyChallenge,
    };
  }

  it("completes the breaker operation on successful challenge and verification responses and cleans up listeners", async () => {
    const capturedResponses: Array<{
      res: express.Response;
      baselineFinish: number;
      baselineClose: number;
    }> = [];
    const { app, breaker, publicKey } = buildAuthTestApp({
      onResponse: (res) => {
        capturedResponses.push({
          res,
          baselineFinish: res.listenerCount("finish"),
          baselineClose: res.listenerCount("close"),
        });
      },
    });

    const executeSpy = jest.spyOn(breaker!, "execute");

    await request(app).get(`/auth/challenge?publicKey=${publicKey}`).expect(200);
    await request(app).post("/auth/challenge").send({ publicKey }).expect(201);
    await request(app)
      .post("/auth/verify")
      .send({ publicKey, nonce: "nonce-1234567890abcdef", signature: "valid-sig" })
      .expect(200);

    expect(executeSpy).toHaveBeenCalledTimes(3);
    for (const result of executeSpy.mock.results) {
      await expect(result.value).resolves.toBeUndefined();
    }

    expect(breaker!.getState()).toMatchObject({
      state: "closed",
      failures: 0,
      successes: 0,
    });

    expect(capturedResponses).toHaveLength(3);
    for (const { res, baselineFinish, baselineClose } of capturedResponses) {
      expect(res.listenerCount("finish")).toBeLessThanOrEqual(baselineFinish);
      expect(res.listenerCount("close")).toBeLessThanOrEqual(baselineClose);
    }
  });

  it("resets consecutive failures when a successful response occurs before the open threshold", async () => {
    const createChallenge = jest.fn();
    const { app, breaker, publicKey } = buildAuthTestApp({ createChallenge });

    // 4 consecutive failures (below failureThreshold = 5)
    for (let i = 0; i < 4; i += 1) {
      createChallenge.mockRejectedValueOnce(new Error("Transient DB error"));
      await request(app).post("/auth/challenge").send({ publicKey }).expect(500);
    }
    expect(breaker!.getState()).toMatchObject({ state: "closed", failures: 4 });

    // 1 successful response must settle the breaker and reset failures to 0
    createChallenge.mockResolvedValueOnce({
      publicKey,
      nonce: "nonce-ok",
      message: "Sign this challenge",
      network: "testnet",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await request(app).post("/auth/challenge").send({ publicKey }).expect(201);
    expect(breaker!.getState()).toMatchObject({ state: "closed", failures: 0 });

    // 4 additional failures should still NOT open the circuit breaker
    for (let i = 0; i < 4; i += 1) {
      createChallenge.mockRejectedValueOnce(new Error("Transient DB error"));
      await request(app).post("/auth/challenge").send({ publicKey }).expect(500);
    }
    expect(breaker!.getState()).toMatchObject({ state: "closed", failures: 4 });

    // Subsequent healthy request still succeeds instead of returning 503
    createChallenge.mockResolvedValueOnce({
      publicKey,
      nonce: "nonce-still-healthy",
      message: "Sign this challenge",
      network: "testnet",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await request(app).post("/auth/challenge").send({ publicKey }).expect(201);
    expect(breaker!.getState()).toMatchObject({ state: "closed", failures: 0 });
  });

  it("closes a half-open breaker after the timeout once enough successful probes complete", async () => {
    let nowMs = 1_700_000_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => nowMs);

    const verifyChallenge = jest.fn();
    const { app, breaker, publicKey } = buildAuthTestApp({
      verifyChallenge,
      withInjectedBreaker: true,
    });

    // Trip the breaker with 5 consecutive failures
    for (let i = 0; i < 5; i += 1) {
      verifyChallenge.mockRejectedValueOnce(new AppError(500, "Upstream failure", "UPSTREAM_ERR"));
      await request(app)
        .post("/auth/verify")
        .send({ publicKey, nonce: `nonce-${i}`, signature: "sig" })
        .expect(500);
    }
    expect(breaker!.getState().state).toBe("open");

    // While open before timeout, requests short-circuit with 503
    const openRes = await request(app)
      .post("/auth/verify")
      .send({ publicKey, nonce: "nonce-open", signature: "sig" })
      .expect(503);
    expect(openRes.body.error.message).toBe("Service temporarily unavailable");
    expect(verifyChallenge).toHaveBeenCalledTimes(5);

    // Advance past the 30s recovery timeout
    nowMs += 30_001;

    // Probe 1 succeeds -> transitions to half-open with 1 recorded success
    verifyChallenge.mockResolvedValueOnce({
      token: "jwt-probe-1",
      tokenType: "Bearer",
      expiresIn: "15m",
      user: { id: "user-1", stellarAddress: publicKey },
    });
    await request(app)
      .post("/auth/verify")
      .send({ publicKey, nonce: "nonce-probe-1", signature: "sig" })
      .expect(200);
    expect(breaker!.getState()).toMatchObject({
      state: "half-open",
      failures: 0,
      successes: 1,
    });

    // Probe 2 succeeds -> meets successThreshold (2) and closes the breaker
    verifyChallenge.mockResolvedValueOnce({
      token: "jwt-probe-2",
      tokenType: "Bearer",
      expiresIn: "15m",
      user: { id: "user-1", stellarAddress: publicKey },
    });
    await request(app)
      .post("/auth/verify")
      .send({ publicKey, nonce: "nonce-probe-2", signature: "sig" })
      .expect(200);
    expect(breaker!.getState()).toMatchObject({
      state: "closed",
      failures: 0,
      successes: 0,
    });
  });

  it("forwards a rejected controller invocation to the error middleware exactly once", async () => {
    const onErrorMiddleware = jest.fn();
    const capturedResponses: Array<{
      res: express.Response;
      baselineFinish: number;
      baselineClose: number;
    }> = [];
    const createChallenge = jest
      .fn()
      .mockRejectedValueOnce(new AppError(401, "Invalid wallet challenge", "AUTH_FAILED"));

    const { app, breaker, publicKey } = buildAuthTestApp({
      createChallenge,
      onErrorMiddleware,
      onResponse: (res) => {
        capturedResponses.push({
          res,
          baselineFinish: res.listenerCount("finish"),
          baselineClose: res.listenerCount("close"),
        });
      },
    });

    const response = await request(app).post("/auth/challenge").send({ publicKey }).expect(401);

    expect(response.body).toEqual({
      success: false,
      error: {
        code: "AUTH_FAILED",
        message: "Invalid wallet challenge",
      },
    });
    expect(onErrorMiddleware).toHaveBeenCalledTimes(1);
    expect(breaker!.getState()).toMatchObject({
      state: "closed",
      failures: 1,
    });
    expect(capturedResponses[0].res.listenerCount("finish")).toBeLessThanOrEqual(
      capturedResponses[0].baselineFinish
    );
    expect(capturedResponses[0].res.listenerCount("close")).toBeLessThanOrEqual(
      capturedResponses[0].baselineClose
    );
  });

  it("recovers using default createAuthRouter configuration without hanging promises", async () => {
    let nowMs = 1_700_000_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => nowMs);

    const createChallenge = jest.fn();
    const { app, publicKey } = buildAuthTestApp({
      createChallenge,
      withInjectedBreaker: false,
    });

    for (let i = 0; i < 5; i += 1) {
      createChallenge.mockRejectedValueOnce(new Error("Service unavailable"));
      await request(app).get(`/auth/challenge?publicKey=${publicKey}`).expect(500);
    }

    await request(app).get(`/auth/challenge?publicKey=${publicKey}`).expect(503);

    nowMs += 30_001;

    for (let probe = 0; probe < 2; probe += 1) {
      createChallenge.mockResolvedValueOnce({
        publicKey,
        nonce: `probe-${probe}`,
        message: "Sign this challenge",
        network: "testnet",
        issuedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + 60_000).toISOString(),
      });
      await request(app).get(`/auth/challenge?publicKey=${publicKey}`).expect(200);
    }

    // Because the 2 probes closed the breaker and reset failures to 0,
    // 4 new failures do NOT immediately re-open the breaker.
    for (let i = 0; i < 4; i += 1) {
      createChallenge.mockRejectedValueOnce(new Error("Intermittent error"));
      await request(app).get(`/auth/challenge?publicKey=${publicKey}`).expect(500);
    }

    createChallenge.mockResolvedValueOnce({
      publicKey,
      nonce: "healthy-again",
      message: "Sign this challenge",
      network: "testnet",
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 60_000).toISOString(),
    });
    await request(app).get(`/auth/challenge?publicKey=${publicKey}`).expect(200);
  });
});
