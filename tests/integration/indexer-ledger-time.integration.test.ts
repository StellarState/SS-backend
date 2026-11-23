import type { DataSource } from "typeorm";
import { createTestDataSource } from "../helpers/test-data-source";
import { SorobanEventLog } from "../../src/models/SorobanEventLog.model";
import { SorobanIndexerCheckpoint } from "../../src/models/SorobanIndexerCheckpoint.model";
import { YieldAdjustment } from "../../src/models/YieldAdjustment.model";
import { AlertPreference } from "../../src/models/AlertPreference.model";
import { OnboardingBonus } from "../../src/models/OnboardingBonus.model";
import { EventIndexerService } from "../../src/services/stellar/event-indexer.service";
import { InvestorInsightsService } from "../../src/services/investor-insights.service";
import type { AppLogger } from "../../src/observability/logger";
import type { DecodedSorobanEvent } from "../../src/types/soroban.types";

/**
 * Issue #812: settlement events keep their ledger time through indexer
 * retries and replays, history orders by ledger time, processing lag stays
 * observable, and events with invalid ledger times are quarantined.
 *
 * Runs the real indexer and settlement projection against SQLite.
 */
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const LEDGER_TIME = "2026-08-25T12:06:00.000Z";

function settlement(
  id: string,
  ledgerClosedAt: string | undefined,
  overrides: Partial<DecodedSorobanEvent> = {}
): DecodedSorobanEvent {
  return {
    id,
    contractId: CONTRACT,
    ledger: 5000,
    ledgerClosedAt: ledgerClosedAt as string,
    txHash: `tx-${id}`,
    topic: "settle",
    topics: ["settle"],
    data: { invoice_id: "INV-812", adjustment_bps: 25 },
    inSuccessfulContractCall: true,
    ...overrides,
  };
}

describe("indexer ledger time preservation (#812)", () => {
  let source: DataSource;
  let logger: AppLogger;
  let insights: InvestorInsightsService;
  let indexer: EventIndexerService;

  beforeAll(async () => {
    source = await createTestDataSource([
      SorobanEventLog,
      SorobanIndexerCheckpoint,
      YieldAdjustment,
      AlertPreference,
      OnboardingBonus,
    ]);
  }, 60000);

  afterAll(async () => {
    if (source?.isInitialized) await source.destroy();
  });

  beforeEach(async () => {
    await source.synchronize(true);
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn().mockReturnThis(),
    } as unknown as AppLogger;
    insights = new InvestorInsightsService(source, {}, logger);
    indexer = new EventIndexerService({
      contractIds: [CONTRACT],
      dataSource: source,
      investorInsightsService: insights,
      logger,
    });
  });

  const logRow = (eventId: string) =>
    source.getRepository(SorobanEventLog).findOneOrFail({ where: { eventId } });
  const yieldRows = () => source.getRepository(YieldAdjustment).find();

  /** First attempt fails after the log row is written: the classic retry path. */
  async function failFirstAttempt(event: DecodedSorobanEvent): Promise<void> {
    const spy = jest
      .spyOn(insights, "processEvent")
      .mockRejectedValueOnce(new Error("transient projection failure"));
    await expect(indexer.ingestEvents([event])).rejects.toThrow("transient projection failure");
    spy.mockRestore();
  }

  describe("replay never changes ledger time", () => {
    it("keeps the stored ledger time when a retry carries a different one", async () => {
      await failFirstAttempt(settlement("evt-a", LEDGER_TIME));
      expect((await logRow("evt-a")).ledgerClosedAt?.toISOString()).toBe(LEDGER_TIME);

      await indexer.ingestEvents([settlement("evt-a", "2026-11-01T09:00:00.000Z")]);

      const row = await logRow("evt-a");
      expect(row.processed).toBe(true);
      expect(row.ledgerClosedAt?.toISOString()).toBe(LEDGER_TIME);
      const [adjustment] = await yieldRows();
      expect(new Date(adjustment.settledAt).toISOString()).toBe(LEDGER_TIME);
      expect(logger.warn).toHaveBeenCalledWith(
        "Replayed event carried a different ledger time; keeping the stored value",
        expect.objectContaining({ eventId: "evt-a", storedLedgerClosedAt: LEDGER_TIME })
      );
    });

    it("uses the stored ledger time, not processing time, when a retry has none", async () => {
      await failFirstAttempt(settlement("evt-b", LEDGER_TIME));

      await indexer.ingestEvents([settlement("evt-b", undefined)]);

      const row = await logRow("evt-b");
      expect(row.processed).toBe(true);
      expect(row.quarantinedAt).toBeNull();
      const [adjustment] = await yieldRows();
      expect(new Date(adjustment.settledAt).toISOString()).toBe(LEDGER_TIME);
    });

    it("preserves settledAt and processedAt when the projection itself is replayed", async () => {
      await insights.processEvent(settlement("evt-c", LEDGER_TIME));
      const [first] = await yieldRows();

      await insights.processEvent(settlement("evt-c", "2026-11-01T09:00:00.000Z"));

      const rows = await yieldRows();
      expect(rows).toHaveLength(1);
      expect(new Date(rows[0].settledAt).toISOString()).toBe(LEDGER_TIME);
      expect(new Date(rows[0].processedAt!).toISOString()).toBe(
        new Date(first.processedAt!).toISOString()
      );
    });

    it("leaves the ingestion time alone across retries", async () => {
      await failFirstAttempt(settlement("evt-d", LEDGER_TIME));
      const ingestedAt = (await logRow("evt-d")).createdAt.toISOString();

      await indexer.ingestEvents([settlement("evt-d", LEDGER_TIME)]);

      expect((await logRow("evt-d")).createdAt.toISOString()).toBe(ingestedAt);
    });
  });

  describe("ordering uses ledger time", () => {
    it("orders history by ledger time, then event id, regardless of processing order", async () => {
      // Processed newest-first, and two share a ledger second.
      for (const [id, time] of [
        ["0000000003-0000000001", "2026-08-27T00:00:00.000Z"],
        ["0000000001-0000000002", "2026-08-25T00:00:00.000Z"],
        ["0000000002-0000000001", "2026-08-26T00:00:00.000Z"],
        ["0000000001-0000000001", "2026-08-25T00:00:00.000Z"],
      ] as const) {
        await insights.processEvent(settlement(id, time));
      }

      const history = await insights.getYieldAdjustmentHistory("INV-812");
      expect(history.map((entry) => entry.settled_at)).toEqual([
        "2026-08-27T00:00:00.000Z",
        "2026-08-26T00:00:00.000Z",
        "2026-08-25T00:00:00.000Z",
        "2026-08-25T00:00:00.000Z",
      ]);
      const latest = await insights.getYieldAdjustment("INV-812");
      expect(latest.settled_at).toBe("2026-08-27T00:00:00.000Z");
    });
  });

  describe("processing lag remains available", () => {
    it("records processing time separately and exposes the lag", async () => {
      const before = Date.now();
      await indexer.ingestEvents([settlement("evt-lag", LEDGER_TIME)]);
      const after = Date.now();

      const row = await logRow("evt-lag");
      expect(row.processedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(row.processedAt!.getTime()).toBeLessThanOrEqual(after + 1000);
      expect(row.ledgerClosedAt?.toISOString()).toBe(LEDGER_TIME);

      const [view] = await insights.getYieldAdjustmentHistory("INV-812");
      expect(view.settled_at).toBe(LEDGER_TIME);
      expect(view.processed_at).not.toBeNull();
      expect(view.processing_lag_ms).toBe(
        new Date(view.processed_at!).getTime() - new Date(LEDGER_TIME).getTime()
      );
    });
  });

  describe("invalid timestamps are quarantined", () => {
    const future = () => new Date(Date.now() + 60 * 60_000).toISOString();

    it.each([
      ["missing", undefined, "invalid_ledger_time:missing"],
      ["no zone", "2026-08-25T12:06:00", "invalid_ledger_time:unparseable"],
      ["impossible date", "2026-02-30T00:00:00Z", "invalid_ledger_time:unparseable"],
      ["epoch zero", "1970-01-01T00:00:00Z", "invalid_ledger_time:before_network_genesis"],
      ["future", "FUTURE", "invalid_ledger_time:in_future"],
    ])("quarantines a %s ledger time without projecting it", async (_label, raw, reason) => {
      const ledgerClosedAt = raw === "FUTURE" ? future() : raw;

      const processed = await indexer.ingestEvents([settlement("evt-bad", ledgerClosedAt)]);

      expect(processed).toBe(0);
      const row = await logRow("evt-bad");
      expect(row.processed).toBe(false);
      expect(row.ledgerClosedAt).toBeNull();
      expect(row.quarantineReason).toBe(reason);
      expect(row.quarantinedAt).not.toBeNull();
      expect(await yieldRows()).toHaveLength(0);
    });

    it("keeps indexing the rest of the batch and advances the checkpoint", async () => {
      const processed = await indexer.ingestEvents([
        settlement("evt-bad", "2026-02-30T00:00:00Z", { ledger: 6000 }),
        settlement("evt-good", LEDGER_TIME, { ledger: 6001 }),
      ]);

      expect(processed).toBe(1);
      expect((await logRow("evt-good")).processed).toBe(true);
      expect(await yieldRows()).toHaveLength(1);
      expect(await indexer.getLastIndexedLedger()).toBeGreaterThanOrEqual(6001);
    });

    it("releases a quarantined event when a replay brings a valid ledger time", async () => {
      await indexer.ingestEvents([settlement("evt-q", "not-a-time")]);
      expect((await logRow("evt-q")).quarantinedAt).not.toBeNull();

      await indexer.ingestEvents([settlement("evt-q", LEDGER_TIME)]);

      const row = await logRow("evt-q");
      expect(row.processed).toBe(true);
      expect(row.quarantineReason).toBeNull();
      expect(row.quarantinedAt).toBeNull();
      expect(row.ledgerClosedAt?.toISOString()).toBe(LEDGER_TIME);
      const [adjustment] = await yieldRows();
      expect(new Date(adjustment.settledAt).toISOString()).toBe(LEDGER_TIME);
    });

    it("does not quarantine an already-processed event replayed with a bad time", async () => {
      await indexer.ingestEvents([settlement("evt-done", LEDGER_TIME)]);

      await indexer.ingestEvents([settlement("evt-done", "garbage")]);

      const row = await logRow("evt-done");
      expect(row.processed).toBe(true);
      expect(row.quarantinedAt).toBeNull();
      expect(row.ledgerClosedAt?.toISOString()).toBe(LEDGER_TIME);
    });
  });
});
