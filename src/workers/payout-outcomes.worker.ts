import { DataSource } from "typeorm";
import { PayoutAttempt } from "../models/PayoutAttempt.model";
import { PayoutClaimsService } from "../services/payout-claims.service";

export interface PayoutTransactionReader {
  getTransaction(hash: string): Promise<{ status: string }>;
}

/** An ambiguous timeout stays pending. Only the ledger can confirm a terminal failure. */
export async function reconcilePayoutOutcomes(
  ds: DataSource,
  reader: PayoutTransactionReader
): Promise<number> {
  const rows = await ds
    .getRepository(PayoutAttempt)
    .createQueryBuilder("p")
    .where("p.status = :status", { status: "pending" })
    .andWhere("p.txHash IS NOT NULL")
    .orderBy("p.lastCheckedAt", "ASC", "NULLS FIRST")
    .addOrderBy("p.key", "ASC")
    .take(25)
    .getMany();
  let failed = 0;
  for (const p of rows) {
    await ds.getRepository(PayoutAttempt).update({ key: p.key }, { lastCheckedAt: new Date() });
    const result = await reader.getTransaction(p.txHash!);
    if (result.status === "FAILED") {
      await new PayoutClaimsService(ds).failConfirmedTransaction(p.key, p.txHash!);
      failed += 1;
    }
  }
  return failed;
}
