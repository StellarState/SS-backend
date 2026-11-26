import express from "express";
import request from "supertest";
import { nativeToScVal } from "@stellar/stellar-sdk";
import type { rpc as SorobanRpc } from "@stellar/stellar-sdk";

import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { logger } from "../../src/observability/logger";
import type { ReferralEarning } from "../../src/models/ReferralEarning.model";
import { createReferralEarningsRouter } from "../../src/routes/referral-earnings.routes";
import { ContractEventBus } from "../../src/services/contract-event-bus.service";
import {
  createReferralEarningsService,
  type ListReferralEarningsOptions,
  type RecordReferralRewardInput,
  type ReferralEarningsRepositoryContract,
  type ReferralStatsTotals,
} from "../../src/services/referral-earnings.service";
import {
  createSorobanReferralReader,
  type ReferralBalanceReader,
} from "../../src/services/stellar/soroban-referral-reader";
import type { DecodedSorobanEvent } from "../../src/types/soroban.types";

class InMemoryReferralEarningsRepository implements ReferralEarningsRepositoryContract {
  readonly rows: ReferralEarning[] = [];
  private seq = 1;

  async recordReferralReward(input: RecordReferralRewardInput): Promise<boolean> {
    if (input.eventId && this.rows.some((r) => r.eventId === input.eventId)) {
      return false;
    }

    const id = `00000000-0000-4000-8000-${String(this.seq++).padStart(12, "0")}`;
    this.rows.push({
      id,
      eventId: input.eventId,
      referrerWallet: input.referrerWallet,
      referredWallet: input.referredWallet,
      amount: input.amount,
      txHash: input.txHash,
      ledgerSequence: input.ledgerSequence,
      earnedAt: input.earnedAt,
      createdAt: input.earnedAt,
    });
    return true;
  }

  async getStatsByWallet(wallet: string): Promise<ReferralStatsTotals> {
    const matching = this.rows.filter((r) => r.referrerWallet === wallet);
    const distinctReferred = new Set(matching.map((r) => r.referredWallet));
    const total = matching.reduce((acc, r) => acc + Number(r.amount), 0);

    return {
      referredCount: distinctReferred.size,
      totalEarned: total.toFixed(4),
    };
  }

  async listEarnings(
    wallet: string,
    options: ListReferralEarningsOptions
  ): Promise<ReferralEarning[]> {
    let filtered = this.rows.filter((r) => r.referrerWallet === wallet);

    if (options.from) {
      const fromMs = options.from.getTime();
      filtered = filtered.filter((r) => r.earnedAt.getTime() >= fromMs);
    }

    if (options.to) {
      const toMs = options.to.getTime();
      filtered = filtered.filter((r) => r.earnedAt.getTime() <= toMs);
    }

    if (options.cursor) {
      const cursorMs = options.cursor.earnedAt.getTime();
      const cursorId = options.cursor.id;
      filtered = filtered.filter((r) => {
        const ms = r.earnedAt.getTime();
        return ms < cursorMs || (ms === cursorMs && r.id < cursorId);
      });
    }

    filtered.sort((a, b) => {
      const timeDiff = b.earnedAt.getTime() - a.earnedAt.getTime();
      if (timeDiff !== 0) return timeDiff;
      return b.id.localeCompare(a.id);
    });

    return filtered.slice(0, options.limit);
  }
}

function makeEvent(overrides: Partial<DecodedSorobanEvent> = {}): DecodedSorobanEvent {
  return {
    id: "evt-1",
    ledger: 1001,
    ledgerClosedAt: "2026-03-01T10:00:00.000Z",
    contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    topic: "ReferralRewardPaid",
    topics: ["ReferralRewardPaid"],
    data: {
      referrer_wallet: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
      referred_wallet: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
      amount: "25.5",
    },
    txHash: "txhash1",
    inSuccessfulContractCall: true,
    ...overrides,
  };
}

describe("ReferralEarningsService & Routes", () => {
  const walletA = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
  const referred1 = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
  const referred2 = "GCQTGZQQ5G4PTM2GL7CDIFKUBIPEC52BROQAPW43N524322A4J67M2Y3";

  it("indexes ReferralRewardPaid events with no gaps and deduplicates replays", async () => {
    const repo = new InMemoryReferralEarningsRepository();
    const service = createReferralEarningsService({ referralEarningsRepository: repo });
    const bus = new ContractEventBus({ handlers: [service] });

    const events: DecodedSorobanEvent[] = [
      makeEvent({
        id: "evt-100",
        ledger: 100,
        topic: "ReferralRewardPaid",
        ledgerClosedAt: "2026-03-01T10:00:00.000Z",
        data: { referrer_wallet: walletA, referred_wallet: referred1, amount: "10" },
      }),
      makeEvent({
        id: "evt-101",
        ledger: 101,
        topic: "referral_reward_paid",
        ledgerClosedAt: "2026-03-02T10:00:00.000Z",
        data: { referrer: walletA, referred: referred2, reward_amount: "15.25" },
      }),
      // Duplicate replay of evt-100 should be ignored idempotently
      makeEvent({
        id: "evt-100",
        ledger: 100,
        topic: "ReferralRewardPaid",
        ledgerClosedAt: "2026-03-01T10:00:00.000Z",
        data: { referrer_wallet: walletA, referred_wallet: referred1, amount: "10" },
      }),
    ];

    for (const evt of events) {
      await bus.dispatch(evt);
    }

    expect(repo.rows).toHaveLength(2);
    expect(repo.rows.map((r) => r.eventId)).toEqual(["evt-100", "evt-101"]);
    expect(repo.rows[0].amount).toBe("10.0000");
    expect(repo.rows[1].amount).toBe("15.2500");
  });

  it("returns accurate referred_count, total_earned, and live unclaimed_balance from GET /referrals/:wallet/stats", async () => {
    const repo = new InMemoryReferralEarningsRepository();
    let liveContractBalance = "42.5";
    const balanceReader: ReferralBalanceReader = {
      getUnclaimedBalance: jest.fn(async () => liveContractBalance),
    };

    const service = createReferralEarningsService({
      referralEarningsRepository: repo,
      balanceReader,
    });

    // Two payouts from referred1 and one from referred2 -> referred_count should be 2
    await service.handle(
      makeEvent({
        id: "evt-1",
        data: { referrer_wallet: walletA, referred_wallet: referred1, amount: "10.5" },
      })
    );
    await service.handle(
      makeEvent({
        id: "evt-2",
        data: { referrer_wallet: walletA, referred_wallet: referred1, amount: "5.25" },
      })
    );
    await service.handle(
      makeEvent({
        id: "evt-3",
        data: { referrer_wallet: walletA, referred_wallet: referred2, amount: "20" },
      })
    );

    const app = express();
    app.use("/api/v1/referrals", createReferralEarningsRouter({ referralEarningsService: service }));
    app.use(createErrorMiddleware(logger));

    const res1 = await request(app).get(`/api/v1/referrals/${walletA}/stats`);
    expect(res1.status).toBe(200);
    expect(res1.body).toEqual({
      success: true,
      data: {
        wallet: walletA,
        referred_count: 2,
        total_earned: "35.7500",
        unclaimed_balance: "42.5000",
      },
    });

    // Verify unclaimed_balance is fetched live (not stale cached)
    liveContractBalance = "12.0";
    const res2 = await request(app).get(`/api/v1/referrals/${walletA}/stats`);
    expect(res2.status).toBe(200);
    expect(res2.body.data.unclaimed_balance).toBe("12.0000");
    expect(balanceReader.getUnclaimedBalance).toHaveBeenCalledTimes(2);
  });

  it("returns cursor-paginated earnings and supports date range filtering on GET /referrals/:wallet/earnings", async () => {
    const repo = new InMemoryReferralEarningsRepository();
    const service = createReferralEarningsService({ referralEarningsRepository: repo });

    await service.handle(
      makeEvent({
        id: "evt-1",
        ledger: 100,
        ledgerClosedAt: "2026-01-10T12:00:00.000Z",
        data: { referrer_wallet: walletA, referred_wallet: referred1, amount: "10" },
      })
    );
    await service.handle(
      makeEvent({
        id: "evt-2",
        ledger: 101,
        ledgerClosedAt: "2026-02-15T12:00:00.000Z",
        data: { referrer_wallet: walletA, referred_wallet: referred2, amount: "20" },
      })
    );
    await service.handle(
      makeEvent({
        id: "evt-3",
        ledger: 102,
        ledgerClosedAt: "2026-03-20T12:00:00.000Z",
        data: { referrer_wallet: walletA, referred_wallet: referred1, amount: "30" },
      })
    );

    const app = express();
    app.use("/api/v1/referrals", createReferralEarningsRouter({ referralEarningsService: service }));
    app.use(createErrorMiddleware(logger));

    // Page 1 (limit=2) -> newest first (March, February)
    const page1 = await request(app).get(`/api/v1/referrals/${walletA}/earnings?limit=2`);
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.data[0]).toMatchObject({
      referred_wallet: referred1,
      amount: "30.0000",
      date: "2026-03-20T12:00:00.000Z",
    });
    expect(page1.body.data[1]).toMatchObject({
      referred_wallet: referred2,
      amount: "20.0000",
      date: "2026-02-15T12:00:00.000Z",
    });
    expect(page1.body.meta.hasMore).toBe(true);
    expect(page1.body.meta.nextCursor).toBeTruthy();

    // Page 2 using nextCursor -> January
    const page2 = await request(app).get(
      `/api/v1/referrals/${walletA}/earnings?limit=2&cursor=${encodeURIComponent(page1.body.meta.nextCursor)}`
    );
    expect(page2.status).toBe(200);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.data[0]).toMatchObject({
      referred_wallet: referred1,
      amount: "10.0000",
      date: "2026-01-10T12:00:00.000Z",
    });
    expect(page2.body.meta.hasMore).toBe(false);
    expect(page2.body.meta.nextCursor).toBeNull();

    // Date range filter: only February
    const filtered = await request(app).get(
      `/api/v1/referrals/${walletA}/earnings?from=2026-02-01T00:00:00.000Z&to=2026-02-28T23:59:59.000Z`
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0].amount).toBe("20.0000");

    // Invalid date range (from > to) -> 400
    const badRange = await request(app).get(
      `/api/v1/referrals/${walletA}/earnings?from=2026-03-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z`
    );
    expect(badRange.status).toBe(400);

    // Invalid date string -> 400
    const badDate = await request(app).get(`/api/v1/referrals/${walletA}/earnings?from=not-a-date`);
    expect(badDate.status).toBe(400);
  });

  it("SorobanReferralReader fetches live unclaimed balance from simulated contract call", async () => {
    const retval = nativeToScVal(BigInt(1250), { type: "i128" });
    const mockServer = {
      simulateTransaction: jest.fn(async () => ({
        result: { retval },
      })),
    } as unknown as SorobanRpc.Server;

    const reader = createSorobanReferralReader({
      contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      server: mockServer,
    });

    const balance = await reader.getUnclaimedBalance(walletA);
    expect(balance).toBe("1250");
    expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(1);
  });
});
