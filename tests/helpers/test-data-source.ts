import { DataSource } from "typeorm";
import { initializeSQLiteDataSource } from "./sqlite-metadata";
import { FeeSchedule, FeeScheduleHistory } from "../../src/models/FeeSchedule.model";
import { IssuerReputation, IssuerReputationHistory } from "../../src/models/IssuerReputation.model";
import { InvestorRiskProfile } from "../../src/models/InvestorRiskProfile.model";
import { InvoiceDraft } from "../../src/models/InvoiceDraft.model";
import { User } from "../../src/models/User.model";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { Transaction } from "../../src/models/Transaction.model";
import { KYCVerification } from "../../src/models/KYCVerification.model";
import { KycHistory } from "../../src/models/KycHistory.model";
import { Notification } from "../../src/models/Notification.model";
import { SecondaryListing } from "../../src/models/SecondaryListing.model";
import { Watchlist } from "../../src/models/Watchlist.model";

/**
 * @param extraEntities Entities a test needs beyond the shared set, e.g. the
 *   indexer tables. Appended, so existing callers are unaffected.
 */
export async function createTestDataSource(
  extraEntities: Array<new (...args: never[]) => unknown> = []
): Promise<DataSource> {
  // SQLite has no native jsonb; `simple-json` preserves object round-trips
  // where a plain text column would return the serialized string.
  return initializeSQLiteDataSource({
    type: "sqlite",
    database: ":memory:",
    entities: [
      FeeSchedule,
      FeeScheduleHistory,
      IssuerReputation,
      IssuerReputationHistory,
      InvestorRiskProfile,
      InvoiceDraft,
      User,
      Invoice,
      Investment,
      // Every entity User, Invoice, or Investment reference by string name in
      // a relation must be registered too, or TypeORM's metadata builder
      // fails to resolve the inverse side (even for tests that never touch
      // these tables).
      Transaction,
      KYCVerification,
      KycHistory,
      Notification,
      SecondaryListing,
      Watchlist,
      ...extraEntities,
    ],
    synchronize: false,
    logging: false,
  });
}
