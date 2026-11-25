import cors from "cors";
import express from "express";
import request from "supertest";
import { createErrorMiddleware } from "@/middleware/error.middleware";
import { logger } from "@/observability/logger";
import { createAdminCorsRotationRouter } from "@/routes/admin/cors-rotation.routes";
import {
  CorsOriginRotationManager,
  CorsOriginValidationError,
  validateCorsOriginList,
} from "@/services/cors-rotation.service";

describe("CORS origin validation, staged rotation, audit trail, and rollback (#911)", () => {
  it("rejects wildcard, null, path-suffixed, credentialed, and production HTTP origins", () => {
    expect(() => validateCorsOriginList(["*"])).toThrow(CorsOriginValidationError);
    expect(() => validateCorsOriginList(["https://*.stellarstate.io"])).toThrow(
      CorsOriginValidationError
    );
    expect(() => validateCorsOriginList(["null"])).toThrow(CorsOriginValidationError);
    expect(() => validateCorsOriginList(["https://app.stellarstate.io/dashboard"])).toThrow(
      CorsOriginValidationError
    );
    expect(() => validateCorsOriginList(["https://app.stellarstate.io/"])).toThrow(
      CorsOriginValidationError
    );
    expect(() => validateCorsOriginList(["https://user:pw@app.stellarstate.io"])).toThrow(
      CorsOriginValidationError
    );
    expect(() => validateCorsOriginList(["http://app.stellarstate.io"], "production")).toThrow(
      CorsOriginValidationError
    );

    expect(
      validateCorsOriginList(
        ["https://app.stellarstate.io", "https://portal.stellarstate.io"],
        "production"
      )
    ).toEqual(["https://app.stellarstate.io", "https://portal.stellarstate.io"]);
  });

  it("supports zero-restart stage, promote, rollback, and audited admin endpoints", async () => {
    const auditEvents: string[] = [];
    const manager = new CorsOriginRotationManager({
      initialOrigins: ["https://v1.stellarstate.io"],
      allowCredentials: true,
      nodeEnv: "production",
      onAudit: (rec) => auditEvents.push(`${rec.action}:${rec.actor}:v${rec.version}`),
    });

    const app = express();
    app.use(
      cors({
        origin: (origin, callback) => {
          if (!origin) {
            callback(null, false);
            return;
          }
          callback(null, manager.isOriginAllowed(origin) ? origin : false);
        },
        credentials: true,
      })
    );
    app.use(express.json());
    app.get("/api/v1/ping", (_req, res) => res.status(200).json({ ok: true }));
    app.use("/api/v1/admin/cors", createAdminCorsRotationRouter(manager, "production"));
    app.use(createErrorMiddleware(logger));

    // 1. Initial: v1 allowed, v2 blocked
    const r1 = await request(app).get("/api/v1/ping").set("Origin", "https://v1.stellarstate.io");
    expect(r1.headers["access-control-allow-origin"]).toBe("https://v1.stellarstate.io");

    const r1Blocked = await request(app)
      .get("/api/v1/ping")
      .set("Origin", "https://v2.stellarstate.io");
    expect(r1Blocked.headers["access-control-allow-origin"]).toBeUndefined();

    // 2. Wildcard stage attempt is rejected with 400
    const badStage = await request(app)
      .post("/api/v1/admin/cors/stage")
      .send({ origins: ["*"] });
    expect(badStage.status).toBe(400);

    // 3. Stage v2: BOTH v1 (active) and v2 (staged next) are served concurrently
    const stageRes = await request(app)
      .post("/api/v1/admin/cors/stage")
      .send({ origins: ["https://v2.stellarstate.io"] });
    expect(stageRes.status).toBe(200);
    expect(stageRes.body.data.currentOrigins).toEqual(["https://v1.stellarstate.io"]);
    expect(stageRes.body.data.nextOrigins).toEqual(["https://v2.stellarstate.io"]);

    const duringStageV1 = await request(app)
      .get("/api/v1/ping")
      .set("Origin", "https://v1.stellarstate.io");
    const duringStageV2 = await request(app)
      .get("/api/v1/ping")
      .set("Origin", "https://v2.stellarstate.io");
    expect(duringStageV1.headers["access-control-allow-origin"]).toBe("https://v1.stellarstate.io");
    expect(duringStageV2.headers["access-control-allow-origin"]).toBe("https://v2.stellarstate.io");

    // 4. Promote staged set: v2 becomes current, v1 retired into previousOrigins
    const promoteRes = await request(app).post("/api/v1/admin/cors/promote").send({});
    expect(promoteRes.status).toBe(200);
    expect(promoteRes.body.data.currentOrigins).toEqual(["https://v2.stellarstate.io"]);
    expect(promoteRes.body.data.previousOrigins).toEqual(["https://v1.stellarstate.io"]);

    const afterPromoteV1 = await request(app)
      .get("/api/v1/ping")
      .set("Origin", "https://v1.stellarstate.io");
    expect(afterPromoteV1.headers["access-control-allow-origin"]).toBeUndefined();

    // 5. Rollback restores v1 immediately without restart
    const rollbackRes = await request(app).post("/api/v1/admin/cors/rollback").send({});
    expect(rollbackRes.status).toBe(200);
    expect(rollbackRes.body.data.currentOrigins).toEqual(["https://v1.stellarstate.io"]);

    const afterRollbackV1 = await request(app)
      .get("/api/v1/ping")
      .set("Origin", "https://v1.stellarstate.io");
    expect(afterRollbackV1.headers["access-control-allow-origin"]).toBe(
      "https://v1.stellarstate.io"
    );

    // 6. Audit trail captured initialize -> stage -> promote -> rollback
    expect(auditEvents).toEqual([
      "initialize:system:v1",
      "stage:admin-key:v2",
      "promote:admin-key:v3",
      "rollback:admin-key:v4",
    ]);
  });
});
