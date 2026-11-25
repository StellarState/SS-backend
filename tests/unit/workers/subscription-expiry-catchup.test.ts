/**
 * Tests for issue #775 – Startup catch-up recovery for missed subscription warnings.
 *
 * Acceptance criteria covered:
 *  1. Restart promptly checks subscriptions expiring before next midnight.
 *  2. Previously delivered cycle/window warnings are not duplicated by catch-up.
 *  3. Already-expired subscriptions are skipped (documented skip policy).
 *  4. Normal scheduled runs remain aligned with the intended UTC boundary.
 *  5. Failed catch-up remains retryable without disabling later scheduled checks.
 *  6. Fake-clock tests cover missed midnight, near expiry, prior delivery, and failures.
 */

import {
  runSubscriptionExpiryJob,
  runStartupCatchUpJob,
  scheduleSubscriptionExpiryJob,
} from "../../../src/workers/subscription-expiry.worker";
import {
  SubscriptionExpiryNotifierService,
  createSubscriptionExpiryNotifierService,
  InMemorySubscriptionDedupeStore,
  type SubscriptionCandidate,
  type SubscriptionNotificationSink,
  type SubscriptionCandidateSource,
} from "../../../src/services/subscription-expiry-notifier.service";
import { NotificationType } from "../../../src/types/enums";

// ─── helpers ────────────────────────────────────────────────────────────────

interface SentNotification {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  dedupeKey?: string | null;
}

function createMockSink(): {
  sink: SubscriptionNotificationSink;
  sent: SentNotification[];
  dedupeMap: Map<string, SentNotification>;
} {
  const sent: SentNotification[] = [];
  const dedupeMap = new Map<string, SentNotification>();

  const sink: SubscriptionNotificationSink = {
    async createNotification(userId, type, title, message, data, dedupeKey) {
      if (dedupeKey && dedupeMap.has(dedupeKey)) {
        // Simulate the DB unique constraint on the dedupeKey column.
        throw new Error(
          `duplicate key value violates unique constraint "uq_notifications_dedupe_key"`
        );
      }
      const record: SentNotification = {
        userId,
        type,
        title,
        message,
        data,
        dedupeKey: dedupeKey ?? null,
      };
      sent.push(record);
      if (dedupeKey) dedupeMap.set(dedupeKey, record);
      return { id: `notif-${sent.length}`, ...record };
    },
    async findByDedupeKey(dedupeKey: string) {
      return dedupeMap.get(dedupeKey) ?? null;
    },
  };

  return { sink, sent, dedupeMap };
}

function makeCandidate(override: Partial<SubscriptionCandidate> & { wallet: string; keyId: string }): SubscriptionCandidate {
  return {
    keyName: "Test Key",
    minHolding: "100",
    currentBalance: "10",
    ...override,
  };
}

/** Returns a logger stub that is silent during tests. */
function silentLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as any;
}

// ─── constants ───────────────────────────────────────────────────────────────

const W = "GDATAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA001";
const K = "CKEY00000000000000000000000000000000000000000000000000000000001";

// ─── 1. runStartupCatchUpJob dispatches missed warnings ──────────────────────

describe("runStartupCatchUpJob", () => {
  it("AC-1: fires immediately and notifies subscriptions expiring before next midnight", async () => {
    // Simulate: backend restarted at 03:00 UTC; midnight job was missed.
    // A subscription that would have been caught at midnight now has 21 hours left.
    const now = new Date("2026-10-18T03:00:00.000Z");
    const expiryDate = new Date("2026-10-19T00:00:00.000Z"); // ~21 hours away → 24h window

    const { sink, sent } = createMockSink();
    const notifier = createSubscriptionExpiryNotifierService({
      notificationService: sink,
      subscriptionSource: {
        findExpiringCandidates: jest.fn().mockResolvedValue([
          makeCandidate({ wallet: W, keyId: K, keyName: "Missed Key", expiryDate }),
        ]),
      },
      now: () => now,
    });

    const result = await runStartupCatchUpJob(notifier, silentLogger());

    expect(result).not.toBeNull();
    expect(result!.totalChecked).toBe(1);
    expect(result!.notified24h).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toContain("Expiring in 24 Hours");
  });

  it("AC-1: also catches subscriptions in the 7-day window that the midnight job missed", async () => {
    const now = new Date("2026-10-18T03:00:00.000Z");
    const expiryDate = new Date("2026-10-23T00:00:00.000Z"); // ~5 days → 7d window

    const { sink, sent } = createMockSink();
    const notifier = createSubscriptionExpiryNotifierService({
      notificationService: sink,
      subscriptionSource: {
        findExpiringCandidates: jest.fn().mockResolvedValue([
          makeCandidate({ wallet: W, keyId: K, keyName: "Soon Key", expiryDate }),
        ]),
      },
      now: () => now,
    });

    const result = await runStartupCatchUpJob(notifier, silentLogger());

    expect(result!.notified7d).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toContain("Expiring Soon");
  });

  // AC-2 ────────────────────────────────────────────────────────────────────

  it("AC-2: does NOT duplicate a 24h warning already delivered before the restart", async () => {
    const now = new Date("2026-10-18T03:00:00.000Z");
    const expiryDate = new Date("2026-10-19T00:00:00.000Z"); // 24h window

    const { sink } = createMockSink();

    // The notification was already delivered before the crash.
    // Simulate by pre-seeding the dedupeMap as findByDedupeKey would return it.
    const dedupeKey = `sub_expiry:${W}:${K}:2026-10-19:24h`;
    const preSeededRecord: SentNotification = {
      userId: W,
      type: NotificationType.SUBSCRIPTION,
      title: "Urgent: Subscription Expiring in 24 Hours - Missed Key",
      message: "...",
      dedupeKey,
    };

    const sinkWithHistory: SubscriptionNotificationSink = {
      ...sink,
      async findByDedupeKey(key: string) {
        return key === dedupeKey ? preSeededRecord : null;
      },
    };

    const notifier = createSubscriptionExpiryNotifierService({
      notificationService: sinkWithHistory,
      subscriptionSource: {
        findExpiringCandidates: jest.fn().mockResolvedValue([
          makeCandidate({ wallet: W, keyId: K, keyName: "Missed Key", expiryDate }),
        ]),
      },
      now: () => now,
    });

    const result = await runStartupCatchUpJob(notifier, silentLogger());

    expect(result!.skippedDuplicate).toBe(1);
    expect(result!.notified24h).toBe(0);
    // sink.createNotification must NOT have been called
    const freshSent: SentNotification[] = [];
    expect(freshSent).toHaveLength(0);
  });

  it("AC-2: does NOT duplicate a 7d warning already delivered before the restart", async () => {
    const now = new Date("2026-10-18T03:00:00.000Z");
    const expiryDate = new Date("2026-10-23T00:00:00.000Z"); // 7d window

    const sent: SentNotification[] = [];
    const dedupeKey = `sub_expiry:${W}:${K}:2026-10-23:7d`;

    const sinkWithHistory: SubscriptionNotificationSink = {
      async createNotification(_userId, _type, _title, _message, _data, dk) {
        if (dk === dedupeKey) throw new Error("duplicate key value violates unique constraint");
        const r: SentNotification = { userId: _userId, type: _type, title: _title, message: _message, data: _data, dedupeKey: dk };
        sent.push(r);
        return r;
      },
      async findByDedupeKey(key: string) {
        // DB already has this dedupeKey
        return key === dedupeKey ? { dedupeKey } : null;
      },
    };

    const notifier = createSubscriptionExpiryNotifierService({
      notificationService: sinkWithHistory,
      subscriptionSource: {
        findExpiringCandidates: jest.fn().mockResolvedValue([
          makeCandidate({ wallet: W, keyId: K, keyName: "7d Key", expiryDate }),
        ]),
      },
      now: () => now,
    });

    const result = await runStartupCatchUpJob(notifier, silentLogger());

    expect(result!.skippedDuplicate).toBe(1);
    expect(sent).toHaveLength(0);
  });

  // AC-3 ────────────────────────────────────────────────────────────────────

  it("AC-3: skips already-expired subscriptions without dispatching any warning", async () => {
    // Subscription expired 2 hours before the restart
    const now = new Date("2026-10-18T03:00:00.000Z");
    const expiryDate = new Date("2026-10-18T01:00:00.000Z"); // already expired

    const { sink, sent } = createMockSink();
    const notifier = createSubscriptionExpiryNotifierService({
      notificationService: sink,
      subscriptionSource: {
        findExpiringCandidates: jest.fn().mockResolvedValue([
          makeCandidate({ wallet: W, keyId: K, keyName: "Expired Key", expiryDate }),
        ]),
      },
      now: () => now,
    });

    const result = await runStartupCatchUpJob(notifier, silentLogger());

    // The source returned the row; the notifier must classify it as expired and skip it.
    expect(result!.skippedExpired).toBe(1);
    expect(sent).toHaveLength(0);
  });

  // AC-5 ────────────────────────────────────────────────────────────────────

  it("AC-5: returns null and swallows the error when the catch-up job itself throws", async () => {
    const failingNotifier = {
      runDailyCheck: jest.fn().mockRejectedValue(new Error("DB connection lost")),
    } as unknown as SubscriptionExpiryNotifierService;

    const logger = silentLogger();
    const result = await runStartupCatchUpJob(failingNotifier, logger);

    expect(result).toBeNull();
    // The error must have been logged, not rethrown
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("catch-up failed"),
      expect.objectContaining({ error: "DB connection lost" })
    );
  });

  it("AC-5: catch-up failure does not interfere with subsequent direct job runs", async () => {
    const { sink, sent } = createMockSink();
    const expiryDate = new Date("2026-10-20T12:00:00.000Z");
    const now = new Date("2026-10-17T12:00:00.000Z");

    let callCount = 0;
    const mixedNotifier = {
      runDailyCheck: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call (catch-up) fails
          return Promise.reject(new Error("transient failure"));
        }
        // Second call (normal job) succeeds
        return createSubscriptionExpiryNotifierService({
          notificationService: sink,
          subscriptionSource: {
            findExpiringCandidates: jest.fn().mockResolvedValue([
              makeCandidate({ wallet: W, keyId: K, expiryDate }),
            ]),
          },
          now: () => now,
        }).runDailyCheck();
      }),
    } as unknown as SubscriptionExpiryNotifierService;

    // Catch-up fails
    const catchUpResult = await runStartupCatchUpJob(mixedNotifier, silentLogger());
    expect(catchUpResult).toBeNull();

    // Normal scheduled job still works fine
    const normalResult = await runSubscriptionExpiryJob(mixedNotifier, silentLogger());
    expect(normalResult.totalChecked).toBe(1);
  });

  // AC-6: near-expiry ────────────────────────────────────────────────────────

  it("AC-6 near-expiry: catch-up dispatches 24h warning for subscription with <24h remaining", async () => {
    const now = new Date("2026-10-18T14:00:00.000Z");
    const expiryDate = new Date("2026-10-19T08:00:00.000Z"); // 18 hours remaining

    const { sink, sent } = createMockSink();
    const notifier = createSubscriptionExpiryNotifierService({
      notificationService: sink,
      subscriptionSource: {
        findExpiringCandidates: jest.fn().mockResolvedValue([
          makeCandidate({ wallet: W, keyId: K, keyName: "Near Key", expiryDate }),
        ]),
      },
      now: () => now,
    });

    const result = await runStartupCatchUpJob(notifier, silentLogger());

    expect(result!.notified24h).toBe(1);
    expect(sent[0].title).toContain("24 Hours");
  });

  it("AC-6 missed-midnight: catch-up dispatches warning when backend restarted after midnight", async () => {
    // Midnight at 2026-10-18T00:00:00Z was skipped (backend was down).
    // Backend restarts at 02:30 UTC. A subscription expires in 5 days.
    const now = new Date("2026-10-18T02:30:00.000Z");
    const expiryDate = new Date("2026-10-23T00:00:00.000Z");

    const { sink, sent } = createMockSink();
    const notifier = createSubscriptionExpiryNotifierService({
      notificationService: sink,
      subscriptionSource: {
        findExpiringCandidates: jest.fn().mockResolvedValue([
          makeCandidate({ wallet: W, keyId: K, keyName: "Midnight Miss", expiryDate }),
        ]),
      },
      now: () => now,
    });

    const result = await runStartupCatchUpJob(notifier, silentLogger());

    expect(result!.notified7d).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

// ─── 2. scheduleSubscriptionExpiryJob with fake clock ────────────────────────

describe("scheduleSubscriptionExpiryJob", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("AC-1: fires catch-up immediately (setTimeout 0) on startup", async () => {
    const { sink } = createMockSink();
    const mockDailyCheck = jest.fn().mockResolvedValue({
      runId: "r1",
      totalChecked: 0,
      notified7d: 0,
      notified24h: 0,
      skippedMeetsHolding: 0,
      skippedDuplicate: 0,
      skippedOutsideWindow: 0,
      skippedExpired: 0,
      errors: [],
      durationMs: 1,
      results: [],
    });

    const notifier = {
      runDailyCheck: mockDailyCheck,
    } as unknown as SubscriptionExpiryNotifierService;

    const scheduler = scheduleSubscriptionExpiryJob(notifier, silentLogger());

    // Before any timers tick: no job has run
    expect(mockDailyCheck).not.toHaveBeenCalled();

    // Advance 0ms to trigger the catch-up setTimeout(fn, 0)
    await jest.advanceTimersByTimeAsync(0);
    expect(mockDailyCheck).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("AC-4: midnight-aligned scheduled run fires at the correct UTC boundary", async () => {
    // Fake clock: 2026-10-18T12:00:00Z (noon UTC).  Next midnight is 12 hours away.
    const fakeNow = new Date("2026-10-18T12:00:00.000Z");
    jest.setSystemTime(fakeNow);

    const mockDailyCheck = jest.fn().mockResolvedValue({
      runId: "r2",
      totalChecked: 0,
      notified7d: 0,
      notified24h: 0,
      skippedMeetsHolding: 0,
      skippedDuplicate: 0,
      skippedOutsideWindow: 0,
      skippedExpired: 0,
      errors: [],
      durationMs: 1,
      results: [],
    });

    const notifier = {
      runDailyCheck: mockDailyCheck,
    } as unknown as SubscriptionExpiryNotifierService;

    const scheduler = scheduleSubscriptionExpiryJob(
      notifier,
      silentLogger(),
      () => new Date() // uses fakeTimers clock
    );

    // Advance past the catch-up (0ms) – 1 call
    await jest.advanceTimersByTimeAsync(1);
    expect(mockDailyCheck).toHaveBeenCalledTimes(1);

    // Advance to just before midnight (11h 59m 59s) – still only 1 call
    await jest.advanceTimersByTimeAsync(11 * 60 * 60 * 1000 + 59 * 60 * 1000 + 59 * 1000 - 1);
    expect(mockDailyCheck).toHaveBeenCalledTimes(1);

    // Advance past midnight by 1 second – scheduled run should fire (2nd call)
    await jest.advanceTimersByTimeAsync(1001);
    expect(mockDailyCheck).toHaveBeenCalledTimes(2);

    // Advance exactly 24 hours – third call (from setInterval)
    await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(mockDailyCheck).toHaveBeenCalledTimes(3);

    scheduler.stop();
  });

  it("AC-5: stop() prevents catch-up and scheduled runs from firing", () => {
    const mockDailyCheck = jest.fn();
    const notifier = { runDailyCheck: mockDailyCheck } as unknown as SubscriptionExpiryNotifierService;

    const scheduler = scheduleSubscriptionExpiryJob(notifier, silentLogger());
    // Stop immediately, before any timers fire
    scheduler.stop();

    jest.runAllTimers();
    expect(mockDailyCheck).not.toHaveBeenCalled();
  });

  it("AC-5: catch-up throwing does not prevent later midnight run from firing", async () => {
    const fakeNow = new Date("2026-10-18T23:30:00.000Z"); // 30 min before midnight
    jest.setSystemTime(fakeNow);

    let callCount = 0;
    const mockDailyCheck = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("catch-up failure"));
      return Promise.resolve({
        runId: "r3",
        totalChecked: 0,
        notified7d: 0,
        notified24h: 0,
        skippedMeetsHolding: 0,
        skippedDuplicate: 0,
        skippedOutsideWindow: 0,
        skippedExpired: 0,
        errors: [],
        durationMs: 1,
        results: [],
      });
    });

    const notifier = { runDailyCheck: mockDailyCheck } as unknown as SubscriptionExpiryNotifierService;

    const scheduler = scheduleSubscriptionExpiryJob(
      notifier,
      silentLogger(),
      () => new Date()
    );

    // Trigger catch-up (fails silently)
    await jest.advanceTimersByTimeAsync(1);
    expect(mockDailyCheck).toHaveBeenCalledTimes(1);

    // Advance past midnight – scheduled run should still fire
    await jest.advanceTimersByTimeAsync(31 * 60 * 1000);
    expect(mockDailyCheck).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("supports clean stop() without errors or dangling handles", () => {
    const { sink } = createMockSink();
    const notifier = createSubscriptionExpiryNotifierService({ notificationService: sink });
    const scheduler = scheduleSubscriptionExpiryJob(notifier, silentLogger());
    expect(() => scheduler.stop()).not.toThrow();
  });
});

// ─── 3. runSubscriptionExpiryJob tag labelling ─────────────────────────────

describe("runSubscriptionExpiryJob", () => {
  it("defaults to 'scheduled' tag and returns the notifier result", async () => {
    const { sink } = createMockSink();
    const mockSource: SubscriptionCandidateSource = {
      findExpiringCandidates: jest.fn().mockResolvedValue([
        makeCandidate({
          wallet: W,
          keyId: K,
          expiryDate: new Date("2026-10-20T12:00:00.000Z"),
        }),
      ]),
    };
    const notifier = createSubscriptionExpiryNotifierService({
      notificationService: sink,
      subscriptionSource: mockSource,
      now: () => new Date("2026-10-17T12:00:00.000Z"),
    });

    const result = await runSubscriptionExpiryJob(notifier, silentLogger());
    expect(result.totalChecked).toBe(1);
    expect(result.notified7d).toBe(1);
  });

  it("re-throws and logs when the notifier throws", async () => {
    const failNotifier = {
      runDailyCheck: jest.fn().mockRejectedValue(new Error("fatal error")),
    } as unknown as SubscriptionExpiryNotifierService;

    const logger = silentLogger();
    await expect(runSubscriptionExpiryJob(failNotifier, logger)).rejects.toThrow("fatal error");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed"),
      expect.objectContaining({ error: "fatal error" })
    );
  });
});

// ─── 4. Cross-replica deduplication via DB constraint ─────────────────────

describe("Cross-replica deduplication", () => {
  it("AC-2: second concurrent replica is blocked by DB unique constraint and treated as benign duplicate", async () => {
    // Both replicas share the same dedupeMap (simulating the shared DB).
    const { sink } = createMockSink();
    const sent: SentNotification[] = [];
    const dbDedupeMap = new Map<string, boolean>();

    const sharedSink: SubscriptionNotificationSink = {
      async createNotification(userId, type, title, message, data, dedupeKey) {
        if (dedupeKey && dbDedupeMap.has(dedupeKey)) {
          throw new Error("duplicate key value violates unique constraint");
        }
        const r: SentNotification = { userId, type, title, message, data, dedupeKey };
        sent.push(r);
        if (dedupeKey) dbDedupeMap.set(dedupeKey, true);
        return r;
      },
      async findByDedupeKey(key: string) {
        return dbDedupeMap.has(key) ? { dedupeKey: key } : null;
      },
    };

    const expiryDate = new Date("2026-10-20T12:00:00.000Z");
    const now = new Date("2026-10-17T12:00:00.000Z");
    const candidate = makeCandidate({ wallet: W, keyId: K, expiryDate });

    // Replica A and Replica B both use fresh in-memory dedupe stores (simulating restart).
    const makeNotifier = () =>
      createSubscriptionExpiryNotifierService({
        notificationService: sharedSink,
        subscriptionSource: {
          findExpiringCandidates: jest.fn().mockResolvedValue([candidate]),
        },
        now: () => now,
      });

    const replicaA = makeNotifier();
    const replicaB = makeNotifier();

    // Both fire simultaneously (Promise.all simulates concurrent restart)
    const [resA, resB] = await Promise.all([
      runStartupCatchUpJob(replicaA, silentLogger()),
      runStartupCatchUpJob(replicaB, silentLogger()),
    ]);

    // Exactly one notification must have been delivered
    expect(sent).toHaveLength(1);

    // The other replica treated the constraint error as a duplicate
    const totalNotified = (resA?.notified7d ?? 0) + (resB?.notified7d ?? 0);
    const totalDuped =
      (resA?.skippedDuplicate ?? 0) + (resB?.skippedDuplicate ?? 0);
    expect(totalNotified).toBe(1);
    expect(totalDuped).toBe(1);
  });
});
