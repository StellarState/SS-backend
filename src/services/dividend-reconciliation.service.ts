import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { DataSource, EntityManager, IsNull } from "typeorm";
import { DividendSnapshot } from "../models/DividendSnapshot.model";
import { DividendAllocation } from "../models/DividendAllocation.model";
import { DividendClaim } from "../models/DividendClaim.model";
import { DividendDistribution } from "../models/DividendDistribution.model";
import { PayoutAttempt } from "../models/PayoutAttempt.model";
import { AppError } from "../utils/http-error";
import { assertRevision, assertSnapshotId, lockPayoutScope } from "./payout-claims.service";
import type {
  DividendAllocationInput,
  DividendDistributionInput,
} from "./dividend-distribution.service";

export const MAX_RECONCILIATION_ATTEMPTS = 3;

export class DividendReconciliationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly now = () => new Date()
  ) {}

  async recordSnapshot(
    input: DividendDistributionInput,
    allocations: DividendAllocationInput[]
  ): Promise<void> {
    const revision = input.revision ?? 1;
    assertRevision(revision);
    const contractId = input.contractId ?? "legacy";
    const cycleId = input.cycleId ?? input.txHash;
    if (!cycleId)
      throw new AppError(400, "Distribution requires a stable cycle ID", "INVALID_CYCLE");
    const values = allocations
      .map((a) => ({
        allocationId: a.allocationId,
        ...(a.legacyAllocationId ? { legacyAllocationId: a.legacyAllocationId } : {}),
        wallet: a.recipientWallet,
        amount: a.amount,
      }))
      .sort((a, b) => a.allocationId.localeCompare(b.allocationId));
    for (const a of values)
      if (!new Decimal(a.amount).isFinite() || new Decimal(a.amount).lt(0))
        throw new AppError(400, "Invalid allocation", "INVALID_AMOUNT");
    const total = values.reduce((sum, a) => sum.plus(a.amount), new Decimal(0)).toFixed(4);
    const contractTotal =
      input.contractTotal === undefined ? input.totalAmount : input.contractTotal;
    const snapshotHash = createHash("sha256")
      .update(
        JSON.stringify([
          contractId,
          cycleId,
          revision,
          input.issuerWallet,
          input.cycleFrequency,
          total,
          contractTotal,
          values,
        ])
      )
      .digest("hex");
    await this.dataSource.transaction(async (m) => {
      await lockPayoutScope(m, `dividend:${contractId}:${cycleId}`);
      const old = await m.findBy(DividendSnapshot, { contractId, cycleId });
      const existing = old.find((s) => s.revision === revision);
      if (existing) {
        if (existing.snapshotHash !== snapshotHash)
          throw new AppError(409, "Cycle snapshot is immutable", "SNAPSHOT_CONFLICT");
        await this.project(m, existing);
        if (
          input.contractClaimed !== undefined &&
          input.contractClaimed !== null &&
          input.contractClaimed !== existing.contractClaimed
        ) {
          await m.update(
            DividendSnapshot,
            { id: existing.id },
            {
              contractClaimed: input.contractClaimed,
              reconciliationStatus: "pending",
              retryCount: 0,
              retryAt: null,
            }
          );
        }
        return;
      }
      if (old.some((s) => s.revision > revision))
        throw new AppError(409, "Cycle revision is stale", "CYCLE_CONFLICT");
      // Lock all prior revisions before replacing the current allocation. Claims lock these same rows.
      for (const s of old) {
        await m.update(DividendSnapshot, { id: s.id }, { locked: true, isCurrent: false });
        const attempts = await m.findBy(PayoutAttempt, { snapshotId: s.id });
        if (
          attempts.some((p) => p.status !== "failed") ||
          (await m.countBy(DividendClaim, { snapshotId: s.id }))
        )
          throw new AppError(409, "Cycle already has reserved payouts", "CYCLE_CONFLICT");
      }
      const legacy = input.txHash
        ? await m.findOneBy(DividendDistribution, {
            txHash: input.txHash,
            issuerWallet: input.issuerWallet,
            distributedAt: input.distributedAt,
            snapshotId: IsNull(),
          })
        : null;
      const snapshot = await m.save(
        DividendSnapshot,
        m.create(DividendSnapshot, {
          ...(legacy ? { id: legacy.id } : {}),
          contractId,
          cycleId,
          revision,
          issuerWallet: input.issuerWallet,
          snapshotHash,
          allocations: values,
          totalAmount: total,
          contractTotal,
          contractClaimed: input.contractClaimed ?? null,
          locked: false,
          cycleFrequency: input.cycleFrequency,
          txHash: input.txHash,
          ledgerSequence: input.ledgerSequence,
          distributedAt: input.distributedAt,
          reconciliationStatus: "pending",
          retryCount: 0,
          retryAt: null,
          report: null,
        })
      );
      await this.project(m, snapshot);
    });
  }

  private async project(m: EntityManager, s: DividendSnapshot): Promise<void> {
    await m
      .createQueryBuilder()
      .insert()
      .into(DividendDistribution)
      .values({
        id: s.id,
        snapshotId: s.id,
        issuerWallet: s.issuerWallet,
        totalAmount: s.totalAmount,
        recipientCount: s.allocations.length,
        cycleFrequency: s.cycleFrequency,
        txHash: s.txHash,
        distributedAt: s.distributedAt,
      })
      .orIgnore()
      .execute();
    await m.update(DividendDistribution, { id: s.id, snapshotId: IsNull() }, { snapshotId: s.id });
    for (const a of s.allocations) {
      const allocationId = createHash("sha256")
        .update(JSON.stringify([s.id, a.allocationId]))
        .digest("hex");
      await m.update(
        DividendAllocation,
        { allocationId: a.legacyAllocationId ?? a.allocationId, snapshotId: IsNull() },
        { allocationId, snapshotId: s.id, distributionId: s.id, revision: s.revision }
      );
      await m
        .createQueryBuilder()
        .insert()
        .into(DividendAllocation)
        .values({
          allocationId,
          snapshotId: s.id,
          distributionId: s.id,
          revision: s.revision,
          issuerWallet: s.issuerWallet,
          recipientWallet: a.wallet,
          amount: a.amount,
          cycleFrequency: s.cycleFrequency,
          txHash: s.txHash,
          ledgerSequence: s.ledgerSequence,
          distributedAt: s.distributedAt,
        })
        .orIgnore()
        .execute();
    }
  }

  async lockCycle(snapshotId: string, issuerWallet: string): Promise<void> {
    assertSnapshotId(snapshotId);
    const result = await this.dataSource
      .getRepository(DividendSnapshot)
      .update({ id: snapshotId, issuerWallet }, { locked: true });
    if (!result.affected) throw new AppError(404, "Cycle not found", "CYCLE_NOT_FOUND");
  }

  /** Persisted progress makes a failed or interrupted job eligible on the next bounded batch. */
  async reconcile(
    snapshotId: string,
    issuerWallet?: string,
    dueOnly = false
  ): Promise<Record<string, unknown>> {
    assertSnapshotId(snapshotId);
    return this.dataSource.transaction(async (m) => {
      const qb = m
        .getRepository(DividendSnapshot)
        .createQueryBuilder("s")
        .where("s.id = :id", { id: snapshotId });
      if (this.dataSource.options.type === "postgres") qb.setLock("pessimistic_write");
      const s = await qb.getOne();
      if (!s || (issuerWallet && s.issuerWallet !== issuerWallet))
        throw new AppError(404, "Cycle not found", "CYCLE_NOT_FOUND");
      if (s.reconciliationStatus === "quarantined") return s.report ?? {};
      if (
        dueOnly &&
        (s.reconciliationStatus === "reconciled" || (s.retryAt && s.retryAt > this.now()))
      )
        return s.report ?? {};
      await this.project(m, s);
      const allocations = await m.findBy(DividendAllocation, { snapshotId: s.id });
      const claims = await m.findBy(DividendClaim, { snapshotId: s.id });
      const attempts = await m.findBy(PayoutAttempt, { snapshotId: s.id });
      const sum = (rows: Array<{ amount: string }>) =>
        rows.reduce((n, r) => n.plus(r.amount), new Decimal(0));
      const allocated = sum(allocations);
      const claimed = sum(claims);
      const gaps: string[] = [];
      const distribution = await m.findOneBy(DividendDistribution, { snapshotId: s.id });
      if (
        !distribution ||
        !new Decimal(distribution.totalAmount).eq(s.totalAmount) ||
        distribution.recipientCount !== s.allocations.length
      )
        gaps.push("distribution_snapshot_mismatch");
      if (!allocated.eq(s.totalAmount)) gaps.push("allocation_total_mismatch");
      if (s.contractTotal === null) gaps.push("contract_total_unavailable");
      else if (!allocated.eq(s.contractTotal)) gaps.push("contract_allocation_mismatch");
      if (claimed.gt(allocated)) gaps.push("claims_exceed_allocations");
      if (s.contractClaimed === null) gaps.push("contract_claimed_unavailable");
      else if (!claimed.eq(s.contractClaimed)) gaps.push("contract_claim_mismatch");
      for (const a of s.allocations) {
        const actual = allocations.find(
          (r) =>
            r.allocationId ===
            createHash("sha256")
              .update(JSON.stringify([s.id, a.allocationId]))
              .digest("hex")
        );
        if (
          !actual ||
          actual.recipientWallet !== a.wallet ||
          !new Decimal(actual.amount).eq(a.amount)
        )
          gaps.push("allocation_snapshot_mismatch");
      }
      if (
        attempts.some(
          (p) =>
            p.status === "succeeded" &&
            !claims.some((c) => c.idempotencyKey === p.key && c.txHash === p.txHash)
        )
      )
        gaps.push("payout_projection_missing");
      s.retryCount = Math.min(MAX_RECONCILIATION_ATTEMPTS, s.retryCount + 1);
      s.reconciliationStatus =
        gaps.length === 0
          ? "reconciled"
          : s.retryCount >= MAX_RECONCILIATION_ATTEMPTS
            ? "quarantined"
            : "retrying";
      s.retryAt =
        s.reconciliationStatus === "retrying"
          ? new Date(this.now().getTime() + 1000 * 2 ** s.retryCount)
          : null;
      // Whitelist operator fields; never include event payloads, errors, credentials or envelopes.
      s.report = {
        snapshotId: s.id,
        revision: s.revision,
        snapshotHash: s.snapshotHash,
        allocated: allocated.toFixed(4),
        claimed: claimed.toFixed(4),
        contractTotal: s.contractTotal,
        contractClaimed: s.contractClaimed,
        pending: attempts
          .filter((p) => p.status === "pending")
          .reduce((n, p) => n.plus(p.net), new Decimal(0))
          .toFixed(4),
        discrepancies: [...new Set(gaps)],
        status: s.reconciliationStatus,
        attempts: s.retryCount,
      };
      await m.save(s);
      return s.report;
    });
  }

  async runBatch(limit = 25): Promise<number> {
    const rows = await this.dataSource
      .getRepository(DividendSnapshot)
      .createQueryBuilder("s")
      .where("s.reconciliationStatus IN (:...statuses)", { statuses: ["pending", "retrying"] })
      .andWhere("(s.retryAt IS NULL OR s.retryAt <= :now)", { now: this.now() })
      .orderBy("s.createdAt", "ASC")
      .addOrderBy("s.id", "ASC")
      .take(Math.min(100, Math.max(1, limit)))
      .getMany();
    for (const s of rows) await this.reconcile(s.id, undefined, true);
    return rows.length;
  }
}
