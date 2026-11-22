import { AddPayoutSnapshotsAndStatements1795500000000 } from "../../src/migrations/1795500000000-AddPayoutSnapshotsAndStatements";
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { DataSource } from "typeorm";
import express from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { DividendSnapshot } from "../../src/models/DividendSnapshot.model";
import { DividendAllocation } from "../../src/models/DividendAllocation.model";
import { DividendClaim } from "../../src/models/DividendClaim.model";
import { DividendDistribution } from "../../src/models/DividendDistribution.model";
import { RoyaltyClaim } from "../../src/models/RoyaltyClaim.model";
import { RoyaltyEvent } from "../../src/models/RoyaltyEvent.model";
import { PayoutAttempt } from "../../src/models/PayoutAttempt.model";
import { PayoutClaimsService } from "../../src/services/payout-claims.service";
import { DividendReconciliationService } from "../../src/services/dividend-reconciliation.service";
import {
  RoyaltyStatementsService,
  statementCsv,
} from "../../src/services/royalty-statements.service";
import {
  createDividendRepository,
  createRoyaltyEarningsRepository,
} from "../../src/services/onchain-projection-repositories";
import { createRoyaltyEarningsService } from "../../src/services/royalty-earnings.service";
import { createDividendDistributionService } from "../../src/services/dividend-distribution.service";
import { createRoyaltiesRouter } from "../../src/routes/royalties.routes";
import { createDividendsRouter } from "../../src/routes/dividends.routes";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { logger } from "../../src/observability/logger";
import { reconcilePayoutOutcomes } from "../../src/workers/payout-outcomes.worker";
import type { AuthService } from "../../src/services/auth.service";
import type { DividendCycleService } from "../../src/services/dividend-cycle.service";
import type {
  DividendDistributionInput,
  DividendAllocationInput,
} from "../../src/services/dividend-distribution.service";
import { UserType } from "../../src/types/enums";

const wallet = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();
const entities = [
  DividendSnapshot,
  DividendAllocation,
  DividendClaim,
  DividendDistribution,
  RoyaltyClaim,
  RoyaltyEvent,
  PayoutAttempt,
];
const pgDescribe = process.env.DATABASE_URL ? describe : describe.skip;

pgDescribe("Payout reliability against PostgreSQL (845, 846, 847, 848)", () => {
  let ds: DataSource;
  let admin: DataSource;
  let claims: PayoutClaimsService;
  let reconciliation: DividendReconciliationService;
  let statements: RoyaltyStatementsService;
  const schema = `payout_test_${randomUUID().replace(/-/g, "")}`;
  const now = new Date("2026-03-01T00:00:00Z");

  beforeAll(async () => {
    admin = await new DataSource({ type: "postgres", url: process.env.DATABASE_URL }).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    ds = await new DataSource({
      type: "postgres",
      url: process.env.DATABASE_URL,
      schema,
      uuidExtension: "pgcrypto",
      extra: { options: `-c search_path=${schema},public`, max: 12 },
      entities,
      synchronize: true,
    }).initialize();
    claims = new PayoutClaimsService(ds);
    reconciliation = new DividendReconciliationService(ds, () => now);
    statements = new RoyaltyStatementsService(ds);
  }, 60000);
  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  beforeEach(async () => {
    await ds.query(
      `TRUNCATE payout_attempts, dividend_claims, dividend_allocations, dividend_distributions, dividend_snapshots, royalty_claims, royalty_events RESTART IDENTITY CASCADE`
    );
  });

  function distribution(revision = 1): DividendDistributionInput {
    return {
      contractId: "contract",
      cycleId: "cycle",
      revision,
      issuerWallet: issuer,
      totalAmount: "100.0000",
      contractClaimed: "0.0000",
      recipientCount: 2,
      cycleFrequency: "monthly",
      txHash: "d".repeat(64),
      ledgerSequence: "10",
      distributedAt: now,
    };
  }
  function allocations(): DividendAllocationInput[] {
    return [wallet, issuer].map((w, i) => ({
      allocationId: `allocation:${i}`,
      distributionId: "cycle",
      issuerWallet: issuer,
      recipientWallet: w,
      amount: i === 0 ? "30.0000" : "70.0000",
      cycleFrequency: "monthly",
      txHash: "d".repeat(64),
      ledgerSequence: "10",
      distributedAt: now,
    }));
  }
  async function cycle() {
    await reconciliation.recordSnapshot(distribution(), allocations());
    return await ds.manager.findOneByOrFail(DividendSnapshot, { revision: 1 });
  }
  async function royalty(revision = 1, id = "event", cycleId = "royalty-cycle") {
    await createRoyaltyEarningsRepository(ds).recordRoyaltyPaid({
      eventId: id,
      keyAddress: "key",
      creatorWallet: wallet,
      buyerWallet: issuer,
      cycleId,
      cycleAt: now,
      revision,
      gross: "12.5000",
      platformFee: "2.5000",
      amount: "10.0000",
      txHash: "e".repeat(64),
      ledgerSequence: "10",
      paidAt: now,
    });
  }

  it("atomically creates one snapshot and one allocation set under concurrent event replay", async () => {
    await Promise.all(
      Array.from({ length: 8 }, () => reconciliation.recordSnapshot(distribution(), allocations()))
    );
    expect(await ds.getRepository(DividendSnapshot).count()).toBe(1);
    expect(await ds.getRepository(DividendDistribution).count()).toBe(1);
    expect(await ds.getRepository(DividendAllocation).count()).toBe(2);
  });
  it("rolls back all distribution writes after an allocation failure", async () => {
    await expect(
      reconciliation.recordSnapshot(distribution(), [
        { ...allocations()[0], recipientWallet: "x".repeat(57) },
      ])
    ).rejects.toThrow();
    expect(await ds.getRepository(DividendSnapshot).count()).toBe(0);
    expect(await ds.getRepository(DividendDistribution).count()).toBe(0);
  });
  it("rejects a changed snapshot in the same revision", async () => {
    await cycle();
    await expect(
      reconciliation.recordSnapshot(distribution(), [{ ...allocations()[0], amount: "31.0000" }])
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await ds.manager.findOneByOrFail(DividendSnapshot, { revision: 1 })).totalAmount).toBe(
      "100.0000"
    );
  });
  it("makes one concurrent claim reservation and returns the original outcome", async () => {
    const s = await cycle();
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => claims.requestDividend(wallet, s.id, 1))
    );
    expect(new Set(outcomes.map((p) => p.key)).size).toBe(1);
    expect(await ds.getRepository(PayoutAttempt).count()).toBe(1);
    expect(outcomes[0].net).toBe("30.0000");
    expect(outcomes[0].snapshotId).toBe(s.id);
    expect(outcomes[0].revision).toBe(1);
  });
  it("serializes a claim behind a cycle lock and rejects it", async () => {
    const s = await cycle();
    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.manager.update(DividendSnapshot, { id: s.id }, { locked: true });
    const pending = claims.requestDividend(wallet, s.id, 1);
    await runner.commitTransaction();
    await runner.release();
    await expect(pending).rejects.toMatchObject({ statusCode: 409 });
    expect(await ds.getRepository(PayoutAttempt).count()).toBe(0);
  });
  it("lets an existing reservation finish after a cycle lock without admitting a new holder", async () => {
    const s = await cycle();
    const p = await claims.requestDividend(wallet, s.id, 1);
    await reconciliation.lockCycle(s.id, issuer);
    expect((await claims.requestDividend(wallet, s.id, 1)).key).toBe(p.key);
    await expect(claims.requestDividend(issuer, s.id, 1)).rejects.toMatchObject({
      statusCode: 409,
    });
    await createDividendRepository(ds).recordClaim({
      claimId: p.key,
      distributionId: "cycle",
      contractId: "contract",
      recipientWallet: wallet,
      issuerWallet: issuer,
      amount: p.net,
      revision: 1,
      cycleFrequency: "monthly",
      txHash: "a".repeat(64),
      ledgerSequence: "11",
      claimedAt: now,
    });
    expect((await claims.requestDividend(wallet, s.id, 1)).status).toBe("succeeded");
  });
  it("rejects old revisions and prevents a recalculation racing reserved payouts", async () => {
    const old = await cycle();
    await reconciliation.recordSnapshot(distribution(2), allocations());
    await expect(claims.requestDividend(wallet, old.id, 1)).rejects.toMatchObject({
      statusCode: 409,
    });
    const current = await ds.manager.findOneByOrFail(DividendSnapshot, { revision: 2 });
    await claims.requestDividend(wallet, current.id, 2);
    await expect(
      reconciliation.recordSnapshot(distribution(3), allocations())
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await ds.manager.findOneByOrFail(DividendSnapshot, { id: current.id })).locked).toBe(
      false
    );
    const view = await createDividendDistributionService({
      dividendRepository: createDividendRepository(ds),
    }).getClaimable(wallet);
    expect(view.totalEarned).toBe("30.0000");
    expect(view.cycles[0].revision).toBe(2);
  });
  it("deduplicates concurrent callbacks and rejects another transaction for the same payout", async () => {
    const s = await cycle();
    const p = await claims.requestDividend(wallet, s.id, 1);
    const input = {
      claimId: p.key,
      recipientWallet: wallet,
      issuerWallet: issuer,
      distributionId: "cycle",
      contractId: "contract",
      revision: 1,
      amount: "30.0000",
      cycleFrequency: "monthly",
      txHash: "a".repeat(64),
      ledgerSequence: "11",
      claimedAt: now,
    };
    await Promise.all(
      Array.from({ length: 8 }, () => createDividendRepository(ds).recordClaim(input))
    );
    expect(await ds.getRepository(DividendClaim).count()).toBe(1);
    await expect(
      createDividendRepository(ds).recordClaim({
        ...input,
        claimId: "different",
        txHash: "b".repeat(64),
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it("repairs a missing allocation and reports independently witnessed contract totals", async () => {
    const s = await cycle();
    await ds.getRepository(DividendAllocation).delete({ recipientWallet: wallet });
    const report = await reconciliation.reconcile(s.id);
    expect(report).toMatchObject({
      status: "reconciled",
      allocated: "100.0000",
      claimed: "0.0000",
      discrepancies: [],
    });
    expect(await ds.getRepository(DividendAllocation).count()).toBe(2);
    expect(await ds.getRepository(PayoutAttempt).count()).toBe(0);
  });
  it("persists bounded retries and quarantine across worker recreation without leaking payloads", async () => {
    const input = { ...distribution(), totalAmount: "99.0000", contractClaimed: null };
    await reconciliation.recordSnapshot(input, allocations());
    const s = await ds.manager.findOneByOrFail(DividendSnapshot, { revision: 1 });
    for (let i = 0; i < 3; i++) await new DividendReconciliationService(ds).reconcile(s.id);
    const report = await reconciliation.reconcile(s.id);
    expect(report).toMatchObject({
      status: "quarantined",
      attempts: 3,
      discrepancies: ["contract_allocation_mismatch", "contract_claimed_unavailable"],
    });
    expect(await reconciliation.runBatch()).toBe(0);
    expect(JSON.stringify(report)).not.toMatch(/secret|token|private|envelope|payload/i);
  });
  it("counts pending and confirmed payouts without resending them", async () => {
    const s = await cycle();
    const p = await claims.requestDividend(wallet, s.id, 1);
    expect(await reconciliation.reconcile(s.id)).toMatchObject({ pending: "30.0000" });
    expect(await ds.getRepository(PayoutAttempt).count()).toBe(1);
    await claims.bindTransaction(p.key, "a".repeat(64));
    await expect(claims.bindTransaction(p.key, "b".repeat(64))).rejects.toMatchObject({
      statusCode: 409,
    });
  });
  it("gives one royalty attempt to concurrent submissions and callbacks", async () => {
    await royalty();
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => claims.requestRoyalty(wallet, "royalty-cycle", 1))
    );
    expect(new Set(outcomes.map((p) => p.key)).size).toBe(1);
    expect(outcomes[0]).toMatchObject({ gross: "12.5000", platformFee: "2.5000", net: "10.0000" });
    const input = {
      claimId: outcomes[0].key,
      cycleId: "royalty-cycle",
      revision: 1,
      keyAddress: "key",
      creatorWallet: wallet,
      amount: "10.0000",
      txHash: "a".repeat(64),
      ledgerSequence: "11",
      claimedAt: now,
    };
    await Promise.all(
      Array.from({ length: 8 }, () => createRoyaltyEarningsRepository(ds).recordRoyaltyClaim(input))
    );
    expect(await ds.getRepository(RoyaltyClaim).count()).toBe(1);
    expect((await claims.requestRoyalty(wallet, "royalty-cycle", 1)).status).toBe("succeeded");
  });
  it("keeps ambiguous outcomes pending and allows a corrected revision after confirmed failure", async () => {
    await royalty();
    const p = await claims.requestRoyalty(wallet, "royalty-cycle", 1);
    await claims.bindTransaction(p.key, "a".repeat(64));
    const reader = { getTransaction: jest.fn().mockResolvedValue({ status: "NOT_FOUND" }) };
    expect(await reconcilePayoutOutcomes(ds, reader)).toBe(0);
    expect((await claims.requestRoyalty(wallet, "royalty-cycle", 1)).status).toBe("pending");
    reader.getTransaction.mockResolvedValue({ status: "FAILED" });
    expect(await reconcilePayoutOutcomes(ds, reader)).toBe(1);
    expect((await claims.requestRoyalty(wallet, "royalty-cycle", 1)).status).toBe("failed");
    await royalty(2, "corrected-event");
    const retry = await claims.requestRoyalty(wallet, "royalty-cycle", 2);
    expect(retry.key).not.toBe(p.key);
    expect(retry.status).toBe("pending");
    await expect(claims.failConfirmedTransaction(retry.key, "b".repeat(64))).rejects.toMatchObject({
      statusCode: 409,
    });
  });
  it("does not change a reserved royalty amount when a late event arrives", async () => {
    await royalty();
    await claims.requestRoyalty(wallet, "royalty-cycle", 1);
    await expect(royalty(1, "late-event")).rejects.toMatchObject({ statusCode: 409 });
    expect(await ds.getRepository(RoyaltyEvent).count()).toBe(1);
  });
  it("deduplicates each royalty event rather than collapsing an entire transaction", async () => {
    await Promise.all(Array.from({ length: 8 }, () => royalty()));
    await royalty(1, "event-2", "another-cycle");
    expect(await ds.getRepository(RoyaltyEvent).count()).toBe(2);
  });
  it("pages unique statement rows while dates change and new rows arrive", async () => {
    for (let i = 0; i < 5; i++) await royalty(1, `event-${i}`, `cycle-${i}`);
    const first = await statements.list(wallet, { limit: 2 });
    await ds
      .getRepository(RoyaltyEvent)
      .update({ id: first.items[0].id }, { paidAt: new Date("2025-01-01") });
    await royalty(1, "new-event", "new-cycle");
    const seen = [...first.items];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await statements.list(wallet, { limit: 2, cursor });
      seen.push(...page.items);
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen.map((r) => r.id)).size).toBe(5);
  });
  it("composes range and key filters with pagination and reconciles JSON and CSV totals", async () => {
    await royalty(1, "first", "first");
    await royalty(2, "second", "second");
    await createRoyaltyEarningsRepository(ds).recordRoyaltyPaid({
      eventId: "outside",
      creatorWallet: wallet,
      keyAddress: "outside",
      buyerWallet: null,
      amount: "1.0000",
      gross: "1.0000",
      platformFee: "0.0000",
      revision: 1,
      paidAt: new Date("2025-01-01"),
      cycleAt: new Date("2025-01-01"),
      cycleId: "outside",
      txHash: null,
      ledgerSequence: null,
    });
    const options = { cycleFrom: "2026-03-01", cycleTo: "2026-03-31", keyAddress: "key", limit: 1 };
    const first = await statements.list(wallet, options);
    const second = await statements.list(wallet, { ...options, cursor: first.nextCursor });
    const exported = await statements.export(wallet, options);
    expect(exported.items.map((r) => r.id)).toEqual(
      [...first.items, ...second.items].map((r) => r.id)
    );
    expect(exported.totals).toEqual({ gross: "25.0000", platformFee: "5.0000", net: "20.0000" });
    const csv = statementCsv(exported.items).trim().split("\r\n");
    expect(csv).toHaveLength(3);
    const net = csv
      .slice(1)
      .reduce((sum, line) => sum.plus(line.split(",")[7].replace(/"/g, "")), new Decimal(0));
    expect(net.toFixed(4)).toBe(exported.totals.net);
    await expect(
      statements.list(wallet, { ...options, keyAddress: "different", cursor: first.nextCursor })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect((await statements.list(issuer)).items).toHaveLength(0);
    expect((await statements.list(wallet, { ...options, revision: 2 })).items).toHaveLength(1);
  });
  it("rejects invalid filters and spreadsheet formulas are escaped", async () => {
    await expect(statements.list(wallet, { cycleFrom: "invalid" })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      statements.list(wallet, { cycleFrom: "2026-04-01", cycleTo: "2026-03-01" })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(statements.list(wallet, { cursor: "garbage" })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(statements.list(wallet, { limit: 101 })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(statements.list(wallet, { revision: 0 })).rejects.toMatchObject({
      statusCode: 400,
    });
    await royalty();
    const row = (await statements.list(wallet)).items[0];
    expect(statementCsv([{ ...row, keyAddress: '=SUM(1,2)"' }])).toContain('"\'=SUM(1,2)"""');
  });

  it("validates payout migration rollback, legacy backfill and reapplication", async () => {
    const q = ds.createQueryRunner();
    await q.connect();
    const migration = new AddPayoutSnapshotsAndStatements1795500000000();
    try {
      await q.startTransaction();
      await migration.down(q);
      await q.commitTransaction();
      await q.query(
        `INSERT INTO royalty_events (key_address, creator_wallet, amount, paid_at) VALUES ('legacy', 'wallet', 12.5000, '2026-03-01')`
      );
      await q.startTransaction();
      await migration.up(q);
      await q.commitTransaction();
      const [row] = await q.query(
        "SELECT gross, platform_fee, cycle_at, statement_sequence FROM royalty_events WHERE key_address = 'legacy'"
      );
      expect(row).toMatchObject({ gross: "12.5000", platform_fee: "0.0000" });
      expect(row.cycle_at).toBeTruthy();
      expect(row.statement_sequence).toBeTruthy();
      await q.startTransaction();
      await migration.down(q);
      await migration.up(q);
      await q.commitTransaction();
    } finally {
      if (q.isTransactionActive) await q.rollbackTransaction();
      await q.release();
    }
  });

  it("rejects callback metadata from another cycle or revision", async () => {
    await royalty();
    const p = await claims.requestRoyalty(wallet, "royalty-cycle", 1);
    const input = {
      claimId: p.key,
      cycleId: "royalty-cycle",
      revision: 1,
      keyAddress: "key",
      creatorWallet: wallet,
      amount: p.net,
      txHash: "a".repeat(64),
      ledgerSequence: "11",
      claimedAt: now,
    };
    await expect(
      createRoyaltyEarningsRepository(ds).recordRoyaltyClaim({ ...input, revision: 2 })
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      createRoyaltyEarningsRepository(ds).recordRoyaltyClaim({ ...input, cycleId: "other" })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await ds.getRepository(RoyaltyClaim).count()).toBe(0);
  });

  it("reports missing contract totals and overlapping worker batches consume only one retry", async () => {
    await reconciliation.recordSnapshot({ ...distribution(), contractTotal: null }, allocations());
    const workers = [
      new DividendReconciliationService(ds, () => now),
      new DividendReconciliationService(ds, () => now),
    ];
    await Promise.all(workers.map((w) => w.runBatch()));
    const s = await ds.manager.findOneByOrFail(DividendSnapshot, { revision: 1 });
    expect(s.retryCount).toBe(1);
    expect(s.report!.discrepancies).toEqual(["contract_total_unavailable"]);
  });

  it("adopts legacy dividend and royalty projections during replay without double counting", async () => {
    const d = await ds
      .getRepository(DividendDistribution)
      .save({
        issuerWallet: issuer,
        totalAmount: "100.0000",
        recipientCount: 2,
        txHash: distribution().txHash,
        distributedAt: now,
        cycleFrequency: "monthly",
      });
    for (const a of allocations())
      await ds.getRepository(DividendAllocation).save({ ...a, distributionId: null });
    const s = await cycle();
    expect(s.id).toBe(d.id);
    expect(await ds.getRepository(DividendDistribution).count()).toBe(1);
    expect(await ds.getRepository(DividendAllocation).count()).toBe(2);
    expect(await reconciliation.reconcile(s.id)).toMatchObject({
      allocated: "100.0000",
      status: "reconciled",
    });
    await ds
      .getRepository(RoyaltyEvent)
      .save({
        keyAddress: "key",
        creatorWallet: wallet,
        buyerWallet: issuer,
        amount: "10.0000",
        txHash: "e".repeat(64),
        ledgerSequence: "10",
        paidAt: now,
      });
    await royalty();
    await royalty();
    expect(await ds.getRepository(RoyaltyEvent).count()).toBe(1);
    expect((await statements.list(wallet)).totals).toEqual({
      gross: "12.5000",
      platformFee: "2.5000",
      net: "10.0000",
    });
  });

  function app() {
    const authService = {
      getCurrentUser: async (token: string) => ({
        id: token,
        stellarAddress: token,
        userType: UserType.SELLER,
      }),
    } as unknown as AuthService;
    const app = express();
    app.use(express.json());
    app.use(
      "/royalties",
      createRoyaltiesRouter({
        authService,
        payoutClaimsService: claims,
        royaltyStatementsService: statements,
        royaltyEarningsService: createRoyaltyEarningsService({
          royaltyRepository: createRoyaltyEarningsRepository(ds),
        }),
      })
    );
    app.use(
      "/dividends",
      createDividendsRouter({
        authService,
        payoutClaimsService: claims,
        dividendReconciliationService: reconciliation,
        dividendCycleService: {} as DividendCycleService,
      })
    );
    app.use(createErrorMiddleware(logger));
    return app;
  }
  it("exposes scoped claim, lock, reconciliation and statement APIs", async () => {
    await royalty();
    const s = await cycle();
    const server = app();
    expect(
      (
        await request(server)
          .post("/royalties/claims")
          .send({ cycleId: "royalty-cycle", revision: 1 })
      ).status
    ).toBe(401);
    const claim = await request(server)
      .post("/royalties/claims")
      .set("Authorization", `Bearer ${wallet}`)
      .send({ cycleId: "royalty-cycle", revision: 1 });
    expect(claim.status).toBe(202);
    const binding = `/royalties/claims/${claim.body.data.key}/transaction`;
    expect(
      (
        await request(server)
          .post(binding)
          .set("Authorization", `Bearer ${issuer}`)
          .send({ txHash: "a".repeat(64) })
      ).status
    ).toBe(404);
    expect(
      (
        await request(server)
          .post(binding)
          .set("Authorization", `Bearer ${wallet}`)
          .send({ txHash: "a".repeat(64) })
      ).status
    ).toBe(200);
    expect(
      (
        await request(server)
          .post(`/dividends/cycles/${s.id}/lock`)
          .set("Authorization", `Bearer ${wallet}`)
      ).status
    ).toBe(404);
    expect(
      (
        await request(server)
          .post(`/dividends/cycles/${s.id}/lock`)
          .set("Authorization", `Bearer ${issuer}`)
      ).status
    ).toBe(204);
    expect(
      (
        await request(server)
          .post("/dividends/claims")
          .set("Authorization", `Bearer ${wallet}`)
          .send({ snapshotId: s.id, revision: 1 })
      ).status
    ).toBe(409);
    expect(
      (
        await request(server)
          .post(`/dividends/cycles/${s.id}/reconcile`)
          .set("Authorization", `Bearer ${issuer}`)
      ).status
    ).toBe(200);
    const listed = await request(server)
      .get("/royalties/statements")
      .set("Authorization", `Bearer ${wallet}`);
    const exported = await request(server)
      .get("/royalties/statements/export?format=json")
      .set("Authorization", `Bearer ${wallet}`);
    expect(listed.status).toBe(200);
    expect(exported.body.data).toEqual(listed.body.data);
    const csv = await request(server)
      .get("/royalties/statements/export?format=csv")
      .set("Authorization", `Bearer ${wallet}`);
    expect(csv.status).toBe(200);
    expect(csv.headers["x-statement-net"]).toBe("10.0000");
    expect(
      (
        await request(server)
          .get("/royalties/statements/export?format=xml")
          .set("Authorization", `Bearer ${wallet}`)
      ).status
    ).toBe(400);
    expect(
      (
        await request(server)
          .get("/royalties/statements?cycle_from=bad")
          .set("Authorization", `Bearer ${wallet}`)
      ).status
    ).toBe(400);
  });
});
