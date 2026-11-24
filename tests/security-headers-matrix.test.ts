import cors from "cors";
import express from "express";
import helmet from "helmet";
import request from "supertest";
import {
  classifySecurityRouteGroup,
  createSecurityHeadersMiddleware,
  DEFAULT_ROUTE_GROUP_POLICIES,
  SecurityHeaderPolicyError,
  validateSecurityHeaderPolicy,
  type SecurityRouteGroup,
} from "@/middleware/security-headers.middleware";

describe("Security header policy matrix and startup drift guard (#913)", () => {
  function buildMatrixTestApp(allowedOrigins: string[] = ["https://app.stellarstate.io"]) {
    const app = express();
    app.use(helmet());
    app.use(
      createSecurityHeadersMiddleware({
        nodeEnv: "production",
        corsAllowedOrigins: allowedOrigins,
        corsAllowCredentials: true,
      })
    );
    app.use(
      cors({
        origin: allowedOrigins,
        credentials: true,
      })
    );

    app.get("/api/v1/invoices", (_req, res) => res.status(200).json({ ok: true }));
    app.get("/api/v1/admin/metrics", (_req, res) => res.status(200).json({ ok: true }));
    app.post("/api/v1/kyc/webhook", (_req, res) => res.status(200).json({ ok: true }));
    app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
    app.get("/docs/portal", (_req, res) => res.status(200).send("<html>ok</html>"));
    return app;
  }

  const routeMatrix: Array<{
    method: "get" | "post";
    path: string;
    expectedGroup: SecurityRouteGroup;
  }> = [
    { method: "get", path: "/api/v1/invoices", expectedGroup: "api" },
    { method: "get", path: "/api/v1/admin/metrics", expectedGroup: "admin" },
    { method: "post", path: "/api/v1/kyc/webhook", expectedGroup: "webhook" },
    { method: "get", path: "/health", expectedGroup: "health" },
    { method: "get", path: "/docs/portal", expectedGroup: "web" },
  ];

  it.each(routeMatrix)(
    "applies expected CSP, HSTS, frame, nosniff, and cache headers on $expectedGroup route ($path)",
    async ({ method, path, expectedGroup }) => {
      const app = buildMatrixTestApp();
      expect(classifySecurityRouteGroup(path)).toBe(expectedGroup);

      const res = await request(app)[method](path);
      const expected = DEFAULT_ROUTE_GROUP_POLICIES[expectedGroup];

      expect(res.status).toBe(200);
      expect(res.headers["content-security-policy"]).toBe(expected.contentSecurityPolicy);
      expect(res.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
      expect(res.headers["x-frame-options"]).toBe(expected.xFrameOptions);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["referrer-policy"]).toBe(expected.referrerPolicy);
      if (expected.cacheControl) {
        expect(res.headers["cache-control"]).toBe(expected.cacheControl);
      }
    }
  );

  it("preserves CORS preflight and credentialed responses across API routes", async () => {
    const allowedOrigin = "https://app.stellarstate.io";
    const app = buildMatrixTestApp([allowedOrigin]);

    const preflight = await request(app)
      .options("/api/v1/invoices")
      .set("Origin", allowedOrigin)
      .set("Access-Control-Request-Method", "GET");

    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(allowedOrigin);
    expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
    expect(preflight.headers["strict-transport-security"]).toContain("max-age=31536000");

    const actual = await request(app).get("/api/v1/invoices").set("Origin", allowedOrigin);
    expect(actual.status).toBe(200);
    expect(actual.headers["access-control-allow-origin"]).toBe(allowedOrigin);
    expect(actual.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("fails startup validation on missing CSP, unsafe-eval, weak production HSTS, or wildcard credentialed CORS", () => {
    expect(() =>
      validateSecurityHeaderPolicy({
        nodeEnv: "production",
        hstsMaxAgeSeconds: 3600,
      })
    ).toThrow(SecurityHeaderPolicyError);

    expect(() =>
      validateSecurityHeaderPolicy({
        nodeEnv: "production",
        corsAllowCredentials: true,
        corsAllowedOrigins: ["*"],
      })
    ).toThrow(SecurityHeaderPolicyError);

    expect(() =>
      validateSecurityHeaderPolicy({
        overrides: {
          web: {
            contentSecurityPolicy: "default-src 'self' 'unsafe-eval'; frame-ancestors 'none'",
          },
        },
      })
    ).toThrow(SecurityHeaderPolicyError);

    expect(() =>
      validateSecurityHeaderPolicy({
        overrides: {
          api: {
            contentSecurityPolicy: "default-src 'none'",
          },
        },
      })
    ).toThrow(SecurityHeaderPolicyError);
  });
});
