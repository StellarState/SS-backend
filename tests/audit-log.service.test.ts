import { readFileSync } from "node:fs";
import { join } from "node:path";
import express, { type Request, type Response } from "express";
import request from "supertest";

import {
  AuditService,
  GENESIS_PREV_HASH,
  InMemoryAuditLogStore,
  setActiveAuditService,
} from "@/services/audit-log.service";
import { Audited } from "@/utils/audited.decorator";
import { createAdminAuditLogsRouter } from "@/routes/admin/audit-logs.routes";
import { createErrorMiddleware } from "@/middleware/error.middleware";
import { logger } from "@/observability/logger";
import { UserType, KYCStatus } from "@/types/enums";
import type { AuthenticatedRequest } from "@/types/auth";

describe("Append-only AuditService, @Audited decorator, and admin endpoints (#869)", () => {
  let store: InMemoryAuditLogStore;
  let auditService: AuditService;

  beforeEach(() => {
    store = new InMemoryAuditLogStore();
    auditService = new AuditService(store);
    setActiveAuditService(auditService);
  });

  it("1. records SHA-256 hash-chained entries with accurate actor across KYC, fee, settlement, and role changes", async () => {
    class MockAdminController {
      @Audited("kyc.approve")
      async approveKyc(_req: Request, res: Response) {
        res.status(200).json({ ok: true });
      }

      @Audited("fee.update")
      async updateFee(_req: Request, res: Response) {
        res.status(200).json({ ok: true });
      }

      @Audited("settlement.manual")
      async settleManual(_req: Request, res: Response) {
        res.status(200).json({ ok: true });
      }

      @Audited("admin.role_change")
      async updateRole(_req: Request, res: Response) {
        res.status(200).json({ ok: true });
      }
    }

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const actor = req.header("x-test-actor") ?? "GADMINWALLET0001";
      (req as AuthenticatedRequest).user = {
        id: "admin-1",
        stellarAddress: actor,
        email: null,
        userType: UserType.ADMIN,
        role: "admin",
        kycStatus: KYCStatus.APPROVED,
        isKycVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      next();
    });

    const ctrl = new MockAdminController();
    app.post("/api/v1/admin/approve-kyc", (req, res) => ctrl.approveKyc(req, res));
    app.put("/api/v1/admin/fees", (req, res) => ctrl.updateFee(req, res));
    app.post("/api/v1/admin/invoices/:invoiceId/settle", (req, res) => ctrl.settleManual(req, res));
    app.patch("/api/v1/admin/users/:id/role", (req, res) => ctrl.updateRole(req, res));

    await request(app)
      .post("/api/v1/admin/approve-kyc")
      .set("x-test-actor", "GADMIN_KYC_ACTOR")
      .send({ userId: "u-100", reviewerId: "rev-1" })
      .expect(200);

    await request(app)
      .put("/api/v1/admin/fees")
      .set("x-test-actor", "GADMIN_FEE_ACTOR")
      .send({ platformFeeBps: 125, changeReason: "Q4 adjustment" })
      .expect(200);

    await request(app)
      .post("/api/v1/admin/invoices/inv-77/settle")
      .set("x-test-actor", "GADMIN_SETTLE_ACTOR")
      .send({ repaymentAmount: "5000.00" })
      .expect(200);

    await request(app)
      .patch("/api/v1/admin/users/u-200/role")
      .set("x-test-actor", "GADMIN_ROLE_ACTOR")
      .send({ role: "admin", reason: "On-call promotion" })
      .expect(200);

    const page = await auditService.list({ limit: 10 });
    expect(page.items).toHaveLength(4);
    expect(page.items.map((x) => x.action)).toEqual([
      "kyc.approve",
      "fee.update",
      "settlement.manual",
      "admin.role_change",
    ]);
    expect(page.items.map((x) => x.actor)).toEqual([
      "GADMIN_KYC_ACTOR",
      "GADMIN_FEE_ACTOR",
      "GADMIN_SETTLE_ACTOR",
      "GADMIN_ROLE_ACTOR",
    ]);

    expect(page.items[0].prevHash).toBe(GENESIS_PREV_HASH);
    expect(page.items[1].prevHash).toBe(page.items[0].hash);
    expect(page.items[2].prevHash).toBe(page.items[1].hash);
    expect(page.items[3].prevHash).toBe(page.items[2].hash);

    const verification = await auditService.verifyChain();
    expect(verification.valid).toBe(true);
    expect(verification.checkedCount).toBe(4);
    expect(verification.brokenEntry).toBeNull();
  });

  it("2. redacts sensitive tokens, secrets, passwords, and API keys before hashing and storage", async () => {
    const entry = await auditService.record({
      actor: "GADMIN_SEC",
      action: "kyc.approve",
      resource: "/api/v1/admin/approve-kyc",
      before: { apiKey: "live_sk_12345", status: "pending" },
      after: {
        status: "approved",
        accessToken: "eyJhbGciOiJIUzI1NiJ9.secret",
        nested: {
          password: "hunter2password",
          privateKey: "SB7XSECRETSEED",
          note: "verified passport",
        },
      },
    });

    expect(entry.before).toEqual({ apiKey: "[REDACTED]", status: "pending" });
    expect(entry.after).toEqual({
      status: "approved",
      accessToken: "[REDACTED]",
      nested: {
        password: "[REDACTED]",
        privateKey: "[REDACTED]",
        note: "verified passport",
      },
    });
    expect(JSON.stringify(entry)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(JSON.stringify(entry)).not.toContain("hunter2password");
    expect(JSON.stringify(entry)).not.toContain("SB7XSECRETSEED");
  });

  it("3. detects tampering and reports the exact first broken link on verify", async () => {
    await auditService.record({
      actor: "GADMIN_1",
      action: "fee.update",
      resource: "/api/v1/admin/fees",
      after: { platformFeeBps: 100 },
    });
    const second = await auditService.record({
      actor: "GADMIN_1",
      action: "settlement.manual",
      resource: "/api/v1/admin/invoices/inv-9/settle",
      after: { repaymentAmount: "1000" },
    });
    await auditService.record({
      actor: "GADMIN_2",
      action: "admin.role_change",
      resource: "/api/v1/admin/users/u-9/role",
      after: { role: "admin" },
    });

    expect((await auditService.verifyChain()).valid).toBe(true);

    // Mutate stored row #2 out-of-band
    store.unsafeMutateRow(second.id, { after: { repaymentAmount: "9999999" } });

    const verifyAfterTamper = await auditService.verifyChain();
    expect(verifyAfterTamper.valid).toBe(false);
    expect(verifyAfterTamper.brokenEntry).not.toBeNull();
    expect(verifyAfterTamper.brokenEntry?.id).toBe(second.id);
    expect(verifyAfterTamper.brokenEntry?.reason).toBe("hash_mismatch");
  });

  it("4. enforces 403 Forbidden for non-admin callers and serves filtered cursor-paginated logs + verify to admins", async () => {
    await auditService.record({
      actor: "GADMIN_A",
      action: "kyc.approve",
      resource: "/api/v1/admin/approve-kyc",
    });
    await auditService.record({
      actor: "GADMIN_B",
      action: "fee.update",
      resource: "/api/v1/admin/fees",
    });
    await auditService.record({
      actor: "GADMIN_A",
      action: "settlement.manual",
      resource: "/api/v1/admin/invoices/1/settle",
    });

    const app = express();
    app.use((req, _res, next) => {
      const roleHeader = req.header("x-mock-role");
      if (roleHeader) {
        (req as AuthenticatedRequest).user = {
          id: "u-test",
          stellarAddress: "GWALLET_TEST",
          email: null,
          userType: roleHeader as UserType,
          role: roleHeader === UserType.ADMIN ? "admin" : "user",
          kycStatus: KYCStatus.APPROVED,
          isKycVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }
      next();
    });
    app.use(
      "/api/admin/audit-logs",
      createAdminAuditLogsRouter({ auditService, enforceAuth: true })
    );
    app.use(createErrorMiddleware(logger));

    // Unauthenticated -> 401
    await request(app).get("/api/admin/audit-logs").expect(401);

    // Non-admin -> 403
    await request(app)
      .get("/api/admin/audit-logs")
      .set("x-mock-role", UserType.INVESTOR)
      .expect(403);

    await request(app)
      .get("/api/admin/audit-logs/verify")
      .set("x-mock-role", UserType.SELLER)
      .expect(403);

    // Admin cursor pagination -> 200
    const page1 = await request(app)
      .get("/api/admin/audit-logs?limit=2")
      .set("x-mock-role", UserType.ADMIN)
      .expect(200);

    expect(page1.body.success).toBe(true);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.meta.hasNextPage).toBe(true);
    expect(page1.body.meta.nextCursor).toBe("2");

    const page2 = await request(app)
      .get(`/api/admin/audit-logs?limit=2&cursor=${page1.body.meta.nextCursor}`)
      .set("x-mock-role", UserType.ADMIN)
      .expect(200);

    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.meta.hasNextPage).toBe(false);

    // Filter by actor
    const filtered = await request(app)
      .get("/api/admin/audit-logs?actor=GADMIN_A")
      .set("x-mock-role", UserType.ADMIN)
      .expect(200);
    expect(filtered.body.data).toHaveLength(2);

    // Verify chain endpoint -> 200 valid: true
    const verifyRes = await request(app)
      .get("/api/admin/audit-logs/verify")
      .set("x-mock-role", UserType.ADMIN)
      .expect(200);
    expect(verifyRes.body.data.valid).toBe(true);
    expect(verifyRes.body.data.checkedCount).toBe(3);
  });

  it("5. migration revokes UPDATE and DELETE grants on audit_logs", () => {
    const migrationSql = readFileSync(
      join(process.cwd(), "src/migrations/1755000000000-CreateAuditLogsTable.ts"),
      "utf8"
    );
    expect(migrationSql).toMatch(
      /REVOKE\s+UPDATE,\s*DELETE\s+ON\s+TABLE\s+"audit_logs"\s+FROM\s+PUBLIC/i
    );
  });
});
