import express from "express";
import request from "supertest";
import {
  evaluateSecretsRotation,
  enforceStartupSecretsPolicy,
  isPlaceholderSecretValue,
  SecretPolicyError,
  startSecretRotationMonitor,
} from "@/config/secrets-rotation";
import { createAdminSecretsRotationRouter } from "@/routes/admin/secrets-rotation.routes";

describe("Secrets rotation and placeholder credential policy (#914)", () => {
  const fixedNow = new Date("2026-11-24T12:00:00.000Z");
  const sensitiveJwt = "super-high-entropy-prod-secret-998877665544332211";
  const sensitiveIpfs = "ipfs-prod-token-aabbccddeeff001122334455";

  it("detects known placeholder credential patterns", () => {
    expect(isPlaceholderSecretValue("changeme")).toBe(true);
    expect(isPlaceholderSecretValue("your-secret-here")).toBe(true);
    expect(isPlaceholderSecretValue("<INSERT_JWT_SECRET>")).toBe(true);
    expect(isPlaceholderSecretValue("${JWT_SECRET}")).toBe(true);
    expect(isPlaceholderSecretValue("aaaaaaaaaaaa")).toBe(true);
    expect(isPlaceholderSecretValue(sensitiveJwt)).toBe(false);
  });

  it("reports secret age and source class without leaking secret values", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      JWT_SECRET: sensitiveJwt,
      JWT_SECRET_ROTATED_AT: "2026-11-10T12:00:00.000Z", // 14 days old -> fresh
      IPFS_JWT: sensitiveIpfs,
      IPFS_JWT_FILE: "/run/secrets/ipfs_jwt",
      IPFS_JWT_ROTATED_AT: "2026-08-01T12:00:00.000Z", // 115 days old -> stale
      KYC_WEBHOOK_SECRET: "kyc-live-hmac-key-7766554433",
      KYC_WEBHOOK_SECRET_ROTATED_AT: "2026-09-05T12:00:00.000Z", // 80 days -> warning
    };

    const report = evaluateSecretsRotation(env, fixedNow);
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain(sensitiveJwt);
    expect(serialized).not.toContain(sensitiveIpfs);
    expect(serialized).not.toContain("kyc-live-hmac-key-7766554433");

    const jwtEntry = report.secrets.find((s) => s.key === "JWT_SECRET");
    expect(jwtEntry).toMatchObject({
      configured: true,
      sourceClass: "env_var",
      state: "fresh",
      ageDays: 14,
    });

    const ipfsEntry = report.secrets.find((s) => s.key === "IPFS_JWT");
    expect(ipfsEntry).toMatchObject({
      configured: true,
      sourceClass: "file_mount",
      state: "stale",
    });
    expect(report.staleCount).toBe(1);
    expect(report.warningCount).toBe(1);
  });

  it("fails startup for placeholder credentials without logging raw secret values", () => {
    const logs: string[] = [];
    const mockLogger = {
      info: (msg: string, meta?: Record<string, unknown>) =>
        logs.push(JSON.stringify({ msg, meta })),
      warn: (msg: string, meta?: Record<string, unknown>) =>
        logs.push(JSON.stringify({ msg, meta })),
      error: (msg: string, meta?: Record<string, unknown>) =>
        logs.push(JSON.stringify({ msg, meta })),
    };

    const placeholder = "replace_with_production_jwt_secret";
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      JWT_SECRET: placeholder,
      IPFS_JWT: sensitiveIpfs,
    };

    let caught: unknown;
    try {
      enforceStartupSecretsPolicy({ env, now: fixedNow, logger: mockLogger });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SecretPolicyError);
    expect((caught as SecretPolicyError).violatingKeys).toEqual(["JWT_SECRET"]);
    expect((caught as Error).message).not.toContain(placeholder);
    expect(logs.join("\n")).not.toContain(placeholder);
    expect(logs.join("\n")).not.toContain(sensitiveIpfs);
  });

  it("emits scheduled rotation warnings and serves redacted admin rotation status", async () => {
    const warnings: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const mockLogger = {
      info: jest.fn(),
      warn: (msg: string, meta?: Record<string, unknown>) => warnings.push({ msg, meta }),
      error: jest.fn(),
    };

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      JWT_SECRET: sensitiveJwt,
      JWT_KEYS: `v1:${sensitiveJwt}`,
      JWT_SECRET_ROTATED_AT: "2026-07-01T00:00:00.000Z",
      IPFS_JWT: sensitiveIpfs,
      IPFS_JWT_ROTATED_AT: "2026-11-20T00:00:00.000Z",
    };

    const monitor = startSecretRotationMonitor({
      env,
      now: fixedNow,
      logger: mockLogger,
      intervalMs: 60_000,
    });
    const report = monitor.runOnce();
    monitor.stop();

    expect(report.staleCount).toBe(1);
    expect(warnings.some((w) => w.meta?.secretKey === "JWT_SECRET")).toBe(true);
    expect(JSON.stringify(warnings)).not.toContain(sensitiveJwt);

    const app = express();
    app.use("/api/v1/admin/secrets", createAdminSecretsRotationRouter({ env, now: () => fixedNow }));

    const res = await request(app).get("/api/v1/admin/secrets/rotation-status");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.staleCount).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain(sensitiveJwt);
  });
});
