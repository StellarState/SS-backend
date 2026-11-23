import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { DataSource, EntityManager } from "typeorm";
import { DividendSnapshot } from "../models/DividendSnapshot.model";
import { DividendClaim } from "../models/DividendClaim.model";
import { RoyaltyClaim } from "../models/RoyaltyClaim.model";
import { RoyaltyEvent } from "../models/RoyaltyEvent.model";
import { PayoutAttempt, PayoutKind } from "../models/PayoutAttempt.model";
import { AppError } from "../utils/http-error";

export function claimKey(
  kind: PayoutKind,
  wallet: string,
  cycle: string,
  revision: number
): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, wallet, cycle, revision]))
    .digest("hex");
}

export function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new AppError(400, "Revision must be a positive integer", "INVALID_REVISION");
  }
}

export function assertSnapshotId(id: string): void {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
    throw new AppError(400, "Invalid snapshot ID", "INVALID_CYCLE");
}

/** PostgreSQL transaction locks serialize absent rows too, across processes. */
export async function lockPayoutScope(m: EntityManager, scope: string): Promise<void> {
  if (m.connection.options.type === "postgres") {
    await m.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [scope]);
  }
}

export class PayoutClaimsService {
  constructor(private readonly dataSource: DataSource) {}

  async requestDividend(
    wallet: string,
    snapshotId: string,
    revision: number
  ): Promise<PayoutAttempt> {
    assertRevision(revision);
    assertSnapshotId(snapshotId);
    return this.dataSource.transaction(async (m) => {
      const qb = m
        .getRepository(DividendSnapshot)
        .createQueryBuilder("s")
        .where("s.id = :id", { id: snapshotId });
      if (this.dataSource.options.type === "postgres") qb.setLock("pessimistic_write");
      const snapshot = await qb.getOne();
      if (!snapshot) throw new AppError(404, "Cycle snapshot not found", "CYCLE_NOT_FOUND");
      const key = claimKey("dividend", wallet, snapshot.id, revision);
      const original = await m.findOneBy(PayoutAttempt, { key });
      if (original) return original;
      if (
        snapshot.locked ||
        !snapshot.isCurrent ||
        snapshot.revision !== revision ||
        snapshot.reconciliationStatus === "quarantined" ||
        (snapshot.contractTotal !== null &&
          !new Decimal(snapshot.contractTotal).eq(snapshot.totalAmount))
      ) {
        throw new AppError(409, "Cycle is locked or has been recalculated", "CYCLE_CONFLICT");
      }
      const earned = snapshot.allocations
        .filter((a) => a.wallet === wallet)
        .reduce((sum, a) => sum.plus(a.amount), new Decimal(0));
      const paid = await m.findBy(DividendClaim, {
        snapshotId: snapshot.id,
        recipientWallet: wallet,
      });
      const remaining = earned.minus(paid.reduce((sum, c) => sum.plus(c.amount), new Decimal(0)));
      if (remaining.lte(0)) throw new AppError(409, "No claimable entitlement", "NO_ENTITLEMENT");
      return m.save(
        PayoutAttempt,
        m.create(PayoutAttempt, {
          key,
          kind: "dividend",
          wallet,
          cycleId: snapshot.id,
          snapshotId: snapshot.id,
          revision,
          gross: remaining.toFixed(4),
          platformFee: "0.0000",
          net: remaining.toFixed(4),
          status: "pending",
          txHash: null,
          failureCode: null,
        })
      );
    });
  }

  async requestRoyalty(wallet: string, cycleId: string, revision: number): Promise<PayoutAttempt> {
    assertRevision(revision);
    if (!cycleId || cycleId.length > 128)
      throw new AppError(400, "Invalid cycle ID", "INVALID_CYCLE");
    return this.dataSource.transaction(async (m) => {
      await lockPayoutScope(m, `royalty:${wallet}:${cycleId}`);
      const key = claimKey("royalty", wallet, cycleId, revision);
      const original = await m.findOneBy(PayoutAttempt, { key });
      if (original) return original;
      const rows = await m.findBy(RoyaltyEvent, { creatorWallet: wallet, cycleId });
      if (!rows.length || Math.max(...rows.map((r) => r.revision)) !== revision) {
        throw new AppError(
          409,
          "Royalty cycle has been recalculated or is unavailable",
          "CYCLE_CONFLICT"
        );
      }
      const previous = await m.findBy(PayoutAttempt, { kind: "royalty", wallet, cycleId });
      if (previous.some((p) => p.status === "pending")) {
        throw new AppError(409, "A payout for this cycle is pending", "CLAIM_PENDING");
      }
      const current = rows.filter((r) => r.revision === revision);
      const gross = current.reduce((sum, r) => sum.plus(r.gross ?? r.amount), new Decimal(0));
      const fee = current.reduce((sum, r) => sum.plus(r.platformFee ?? 0), new Decimal(0));
      const paid = await m.findBy(RoyaltyClaim, { creatorWallet: wallet, cycleId });
      const net = gross
        .minus(fee)
        .minus(paid.reduce((sum, c) => sum.plus(c.amount), new Decimal(0)));
      if (net.lte(0)) throw new AppError(409, "No claimable entitlement", "NO_ENTITLEMENT");
      return m.save(
        PayoutAttempt,
        m.create(PayoutAttempt, {
          key,
          kind: "royalty",
          wallet,
          cycleId,
          revision,
          snapshotId: null,
          gross: net.plus(fee).toFixed(4),
          platformFee: fee.toFixed(4),
          net: net.toFixed(4),
          status: "pending",
          txHash: null,
          failureCode: null,
        })
      );
    });
  }

  /** Bind a prepared payout hash before submission. A retry can only use that hash. */
  async bindTransaction(key: string, txHash: string, wallet?: string): Promise<PayoutAttempt> {
    if (!/^[a-f0-9]{64}$/i.test(txHash))
      throw new AppError(400, "Invalid transaction hash", "INVALID_TRANSACTION");
    return this.dataSource.transaction(async (m) => {
      await lockPayoutScope(m, `attempt:${key}`);
      const p = await m.findOneBy(PayoutAttempt, { key });
      if (!p || (wallet && p.wallet !== wallet))
        throw new AppError(404, "Claim not found", "CLAIM_NOT_FOUND");
      if (p.txHash && p.txHash !== txHash)
        throw new AppError(409, "Claim is bound to another transaction", "TRANSACTION_CONFLICT");
      if (p.status !== "pending") return p;
      p.txHash = txHash;
      return m.save(p);
    });
  }

  /** Only a confirmed unsuccessful transaction may mark a payout terminal. */
  async failConfirmedTransaction(key: string, txHash: string): Promise<PayoutAttempt> {
    return this.dataSource.transaction(async (m) => {
      await lockPayoutScope(m, `attempt:${key}`);
      const p = await m.findOneBy(PayoutAttempt, { key });
      if (!p || p.txHash !== txHash)
        throw new AppError(409, "Transaction does not match claim", "TRANSACTION_CONFLICT");
      if (p.status === "pending") {
        p.status = "failed";
        p.failureCode = "TRANSACTION_FAILED";
        await m.save(p);
      }
      return p;
    });
  }
}
