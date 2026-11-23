import Decimal from "decimal.js";
import { DataSource, EntityManager } from "typeorm";
import { DividendSnapshot } from "../models/DividendSnapshot.model";
import { DividendClaim } from "../models/DividendClaim.model";
import { RoyaltyClaim } from "../models/RoyaltyClaim.model";
import { PayoutAttempt, PayoutKind } from "../models/PayoutAttempt.model";
import { AppError } from "../utils/http-error";
import { assertRevision, claimKey, lockPayoutScope } from "./payout-claims.service";
import type { DividendClaimInput } from "./dividend-distribution.service";
import type { RoyaltyClaimInput } from "./royalty-earnings.service";

async function complete(
  m: EntityManager,
  kind: PayoutKind,
  wallet: string,
  cycleId: string | null,
  revision: number | undefined,
  claimId: string,
  amount: string,
  txHash: string | null,
  snapshotId: string | null
): Promise<string | null> {
  const key =
    cycleId && revision !== undefined ? claimKey(kind, wallet, cycleId, revision) : claimId;
  await lockPayoutScope(m, `attempt:${key}`);
  let attempt = await m.findOneBy(PayoutAttempt, { key });
  if (!attempt && !(cycleId && revision !== undefined)) return null; // Legacy indexed payouts still remain visible.
  if (revision !== undefined) assertRevision(revision);
  if (attempt) {
    if (
      attempt.kind !== kind ||
      attempt.wallet !== wallet ||
      !new Decimal(attempt.net).eq(amount) ||
      (attempt.txHash !== null && attempt.txHash !== txHash) ||
      attempt.status === "failed"
    ) {
      throw new AppError(409, "Callback differs from reserved payout", "PAYOUT_CONFLICT");
    }
  } else {
    attempt = m.create(PayoutAttempt, {
      key,
      kind,
      wallet,
      cycleId: cycleId!,
      revision: revision!,
      snapshotId,
      gross: amount,
      platformFee: "0.0000",
      net: amount,
      txHash: null,
      status: "pending",
      failureCode: null,
    });
  }
  attempt.txHash = txHash;
  attempt.status = "succeeded";
  await m.save(attempt);
  return key;
}

export async function recordDividendCallback(
  ds: DataSource,
  input: DividendClaimInput
): Promise<void> {
  if (input.revision !== undefined) assertRevision(input.revision);
  await ds.transaction(async (m) => {
    let snapshot: DividendSnapshot | null = null;
    const attempt = await m.findOneBy(PayoutAttempt, { key: input.claimId });
    if (attempt?.snapshotId)
      snapshot = await m.findOneBy(DividendSnapshot, { id: attempt.snapshotId });
    if (!snapshot && input.distributionId) {
      const query = m
        .getRepository(DividendSnapshot)
        .createQueryBuilder("s")
        .where("s.contractId = :contractId AND s.cycleId = :cycleId", {
          contractId: input.contractId ?? "legacy",
          cycleId: input.distributionId,
        });
      if (input.revision !== undefined)
        query.andWhere("s.revision = :revision", { revision: input.revision });
      snapshot = await query.orderBy("s.revision", "DESC").getOne();
    }
    if (snapshot && ds.options.type === "postgres") {
      snapshot = await m
        .getRepository(DividendSnapshot)
        .createQueryBuilder("s")
        .where("s.id = :id", { id: snapshot.id })
        .setLock("pessimistic_write")
        .getOne();
    }
    if (
      attempt &&
      ((input.revision !== undefined && input.revision !== attempt.revision) ||
        (snapshot && input.contractId && snapshot.contractId !== input.contractId) ||
        (snapshot &&
          input.distributionId &&
          input.distributionId !== snapshot.cycleId &&
          input.distributionId !== snapshot.id))
    ) {
      throw new AppError(409, "Callback differs from reserved cycle", "PAYOUT_CONFLICT");
    }
    const revision = attempt?.revision ?? input.revision;
    const key = await complete(
      m,
      "dividend",
      input.recipientWallet,
      snapshot?.id ?? null,
      revision,
      input.claimId,
      input.amount,
      input.txHash,
      snapshot?.id ?? null
    );
    await m
      .createQueryBuilder()
      .insert()
      .into(DividendClaim)
      .values({
        ...input,
        claimId: key ?? input.claimId,
        idempotencyKey: key,
        distributionId: snapshot?.id ?? input.distributionId,
        snapshotId: snapshot?.id ?? null,
        revision: revision ?? 1,
      })
      .orIgnore()
      .execute();
    if (snapshot)
      await m.update(
        DividendSnapshot,
        { id: snapshot.id },
        { reconciliationStatus: "pending", retryCount: 0, retryAt: null }
      );
  });
}

export async function recordRoyaltyCallback(
  ds: DataSource,
  input: RoyaltyClaimInput
): Promise<void> {
  if (input.revision !== undefined) assertRevision(input.revision);
  await ds.transaction(async (m) => {
    const attempt = await m.findOneBy(PayoutAttempt, { key: input.claimId });
    if (
      attempt &&
      ((input.revision !== undefined && input.revision !== attempt.revision) ||
        (input.cycleId && input.cycleId !== attempt.cycleId))
    ) {
      throw new AppError(409, "Callback differs from reserved cycle", "PAYOUT_CONFLICT");
    }
    const cycleId = attempt?.cycleId ?? input.cycleId ?? null;
    await lockPayoutScope(m, `royalty:${input.creatorWallet}:${cycleId}`);
    const revision = attempt?.revision ?? input.revision;
    const key = await complete(
      m,
      "royalty",
      input.creatorWallet,
      cycleId,
      revision,
      input.claimId,
      input.amount,
      input.txHash,
      null
    );
    await m
      .createQueryBuilder()
      .insert()
      .into(RoyaltyClaim)
      .values({
        ...input,
        claimId: key ?? input.claimId,
        idempotencyKey: key,
        cycleId,
        revision: revision ?? 1,
      })
      .orIgnore()
      .execute();
  });
}
