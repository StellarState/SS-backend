import {
  InMemoryDeadLetterSink,
  NotificationDispatcher,
  createNotificationDispatchEffect,
  unlessDispatched,
  type DedupedNotification,
  type DedupedNotificationStore,
} from "../../src/lib/notification-dispatcher";
import { InMemoryNotificationJobStore } from "../../src/lib/notification-job-store";
import type { InvoiceTransition } from "../../src/lib/invoice-state-machine";
import type { AppLogger } from "../../src/observability/logger";
import { InvoiceStatus, NotificationType } from "../../src/types/enums";

const silentLogger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const invoice = { id: "inv-1", sellerId: "seller-1", invoiceNumber: "INV-001" };

/** Mirrors the unique dedupe_key index: duplicate keys are silently skipped. */
class FakeStore implements DedupedNotificationStore {
  readonly rows = new Map<string, DedupedNotification>();
  failuresRemaining = 0;
  calls = 0;

  async insertIgnoringDuplicates(entries: DedupedNotification[]): Promise<void> {
    this.calls += 1;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("db unavailable");
    }
    for (const entry of entries) {
      if (!this.rows.has(entry.dedupeKey)) this.rows.set(entry.dedupeKey, entry);
    }
  }

  recipients(): string[] {
    return [...this.rows.values()].map((row) => row.userId).sort();
  }
}

function setup(investorIds: string[] = ["investor-1", "investor-2"]) {
  const store = new FakeStore();
  const deadLetters = new InMemoryDeadLetterSink();
  const dispatcher = new NotificationDispatcher({
    store,
    investors: { findInvestorIds: async () => investorIds },
    deadLetters,
    logger: silentLogger,
    retryDelayMs: 0,
    schedule: (work) => setImmediate(work),
  });
  return { store, deadLetters, dispatcher };
}

function transition(to: InvoiceStatus, trigger = "fully_funded", reason: string | null = null) {
  return {
    invoice,
    from: InvoiceStatus.PUBLISHED,
    to,
    actor: { role: "system" },
    trigger,
    reason,
    history: null,
    occurredAt: new Date(),
  } as unknown as InvoiceTransition;
}

describe("NotificationDispatcher", () => {
  it.each(["funded", "settled"] as const)(
    "fans %s out to the seller and every investor",
    async (kind) => {
      const { store, dispatcher } = setup();

      dispatcher.enqueue({ kind, invoice });
      await dispatcher.drain();

      expect(store.recipients()).toEqual(["investor-1", "investor-2", "seller-1"]);
    }
  );

  it("notifies only the seller on review decisions", async () => {
    const { store, dispatcher } = setup();

    dispatcher.enqueue({ kind: "approved", invoice });
    dispatcher.enqueue({ kind: "rejected", invoice, reason: "Missing documents" });
    await dispatcher.drain();

    const rows = [...store.rows.values()];
    expect(rows.map((r) => r.userId)).toEqual(["seller-1", "seller-1"]);
    expect(rows.map((r) => r.type)).toEqual([
      NotificationType.INVOICE_APPROVED,
      NotificationType.INVOICE_REJECTED,
    ]);
    expect(rows[1].message).toContain("Missing documents");
  });

  it("persists the job before acknowledging enqueue and defers delivery", async () => {
    const { store, dispatcher } = setup();

    expect(await dispatcher.enqueue({ kind: "funded", invoice })).toBe(true);

    expect(store.calls).toBe(0);
  });

  it("does not duplicate notifications for the same event and wallet", async () => {
    const { store, dispatcher } = setup(["investor-1", "investor-1"]);

    expect(await dispatcher.enqueue({ kind: "funded", invoice })).toBe(true);
    expect(await dispatcher.enqueue({ kind: "funded", invoice })).toBe(false);
    await dispatcher.drain();
    // Once delivered the job is gone, so a later re-dispatch is accepted but
    // absorbed by the notification dedupe keys.
    expect(await dispatcher.enqueue({ kind: "funded", invoice })).toBe(true);
    await dispatcher.drain();

    expect(store.recipients()).toEqual(["investor-1", "seller-1"]);
  });

  it("treats separate deadline extensions as separate events", async () => {
    const { store, dispatcher } = setup([]);

    await dispatcher.enqueue({
      kind: "deadline_extended",
      invoice,
      newDeadline: new Date("2026-10-01"),
    });
    await dispatcher.enqueue({
      kind: "deadline_extended",
      invoice,
      newDeadline: new Date("2026-11-01"),
    });
    await dispatcher.drain();

    expect(store.rows.size).toBe(2);
  });

  it("retries a failed dispatch and succeeds within 3 attempts", async () => {
    const { store, deadLetters, dispatcher } = setup();
    store.failuresRemaining = 2;

    dispatcher.enqueue({ kind: "settled", invoice });
    await dispatcher.drain();

    expect(store.calls).toBe(3);
    expect(store.rows.size).toBe(3);
    expect(deadLetters.entries).toHaveLength(0);
  });

  it("dead-letters after 3 failed attempts", async () => {
    const { store, deadLetters, dispatcher } = setup();
    store.failuresRemaining = Infinity;

    dispatcher.enqueue({ kind: "settled", invoice });
    await dispatcher.drain();

    expect(store.calls).toBe(3);
    expect(deadLetters.entries).toEqual([
      expect.objectContaining({
        eventId: "invoice:inv-1:settled",
        attempts: 3,
        error: "db unavailable",
      }),
    ]);
  });
});

/** Mirrors a connection loss after the first recipient was already written. */
class PartialDeliveryStore implements DedupedNotificationStore {
  readonly rows = new Map<string, DedupedNotification>();
  calls = 0;

  async insertIgnoringDuplicates(entries: DedupedNotification[]): Promise<void> {
    this.calls += 1;
    for (const [index, entry] of entries.entries()) {
      if (!this.rows.has(entry.dedupeKey)) this.rows.set(entry.dedupeKey, entry);
      if (this.calls === 1 && index === 0) throw new Error("write lost");
    }
  }
}

function durableSetup(options: {
  jobs: InMemoryNotificationJobStore;
  store: DedupedNotificationStore;
  workerId: string;
  autoDispatch?: boolean;
  maxAttempts?: number;
  retryDelayMs?: number;
  schedule?: (work: () => void, delayMs: number) => void;
}) {
  return new NotificationDispatcher({
    store: options.store,
    investors: { findInvestorIds: async () => ["investor-1", "investor-2"] },
    jobs: options.jobs,
    logger: silentLogger,
    workerId: options.workerId,
    autoDispatch: options.autoDispatch,
    maxAttempts: options.maxAttempts,
    retryDelayMs: options.retryDelayMs ?? 0,
    schedule: options.schedule ?? ((work) => setImmediate(work)),
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for state");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("NotificationDispatcher durable recovery (issue #772)", () => {
  it("delivers a job acknowledged before a restart", async () => {
    const jobs = new InMemoryNotificationJobStore();
    const store = new FakeStore();
    const before = durableSetup({ jobs, store, workerId: "before", autoDispatch: false });

    expect(await before.enqueue({ kind: "funded", invoice })).toBe(true);
    expect(store.calls).toBe(0);

    // The first process disappears without running any delivery work.
    const after = durableSetup({ jobs, store, workerId: "after", autoDispatch: false });
    // While the recovered job is still pending, its identity absorbs a retry.
    expect(await after.enqueue({ kind: "funded", invoice })).toBe(false);

    await after.recover();
    await after.drain();

    expect(store.recipients()).toEqual(["investor-1", "investor-2", "seller-1"]);
  });

  it("does not duplicate recipients when racing workers share the queue", async () => {
    const jobs = new InMemoryNotificationJobStore();
    const store = new FakeStore();
    const a = durableSetup({ jobs, store, workerId: "a", autoDispatch: false });
    const b = durableSetup({ jobs, store, workerId: "b", autoDispatch: false });

    await a.enqueue({ kind: "funded", invoice });
    await Promise.all([a.recover(), b.recover()]);
    await Promise.all([a.drain(), b.drain()]);

    expect(store.calls).toBe(1);
    expect(store.recipients()).toEqual(["investor-1", "investor-2", "seller-1"]);
  });

  it("persists attempts and the scheduled retry time across worker replacement", async () => {
    const jobs = new InMemoryNotificationJobStore();
    const store = new FakeStore();
    store.failuresRemaining = Infinity;
    const eventId = "invoice:inv-1:settled";

    const first = durableSetup({
      jobs,
      store,
      workerId: "first",
      autoDispatch: false,
      maxAttempts: 3,
      retryDelayMs: 5_000,
      schedule: () => undefined, // no retry timer in this test
    });
    await first.enqueue({ kind: "settled", invoice });
    await first.recover();
    await waitFor(() => jobs.peek(eventId)?.status === "pending");

    const persisted = jobs.peek(eventId)!;
    expect(persisted.attempts).toBe(1);
    expect(persisted.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // A replacement worker sees the same attempt count and schedule; the retry
    // is not due yet, so nothing is claimed or reset.
    const second = durableSetup({
      jobs,
      store,
      workerId: "second",
      autoDispatch: false,
      maxAttempts: 3,
      retryDelayMs: 0,
      schedule: () => undefined,
    });
    await second.recover();

    const afterReplacement = jobs.peek(eventId)!;
    expect(afterReplacement.attempts).toBe(1);
    expect(afterReplacement.nextAttemptAt).toEqual(persisted.nextAttemptAt);
    expect(store.calls).toBe(1);
  });

  it("resumes partial delivery without notifying reached recipients again", async () => {
    const jobs = new InMemoryNotificationJobStore();
    const store = new PartialDeliveryStore();
    const dispatcher = durableSetup({ jobs, store, workerId: "partial" });

    await dispatcher.enqueue({ kind: "funded", invoice });
    await dispatcher.drain();

    expect(store.calls).toBe(2);
    expect([...store.rows.values()].map((row) => row.userId).sort()).toEqual([
      "investor-1",
      "investor-2",
      "seller-1",
    ]);
  });

  it("retains terminal failures for inspection and deliberate replay", async () => {
    const jobs = new InMemoryNotificationJobStore();
    const store = new FakeStore();
    store.failuresRemaining = Infinity;
    const eventId = "invoice:inv-1:settled";

    const dispatcher = durableSetup({
      jobs,
      store,
      workerId: "dead-letter",
      maxAttempts: 2,
    });
    await dispatcher.enqueue({ kind: "settled", invoice });
    await dispatcher.drain();

    expect(store.calls).toBe(2);
    expect(await dispatcher.listDeadLetters()).toEqual([
      expect.objectContaining({ eventId, attempts: 2, error: "db unavailable" }),
    ]);

    // The dead letter outlives the worker that produced it.
    const replacement = durableSetup({
      jobs,
      store,
      workerId: "replacement",
      maxAttempts: 2,
      autoDispatch: false,
    });
    expect(await replacement.listDeadLetters()).toHaveLength(1);

    store.failuresRemaining = 0;
    expect(await replacement.replayDeadLetter(eventId)).toBe(true);
    await replacement.drain();

    expect(store.recipients()).toEqual(["investor-1", "investor-2", "seller-1"]);
    expect(await replacement.listDeadLetters()).toHaveLength(0);
  });
});

describe("NotificationJobStore ownership and retention", () => {
  const event = { kind: "funded" as const, invoice };

  it("rejects completion or retry writes from a worker that lost the claim", async () => {
    const jobs = new InMemoryNotificationJobStore();
    const now = new Date("2026-11-21T12:00:00.000Z");
    await jobs.create({ eventId: "evt", event, nextAttemptAt: now });

    const [claimed] = await jobs.claimDue({ workerId: "owner", now, limit: 1, leaseMs: 1_000 });
    expect(claimed.attempts).toBe(1);

    expect(await jobs.complete("evt", "other")).toBe(false);
    expect(await jobs.reschedule("evt", "other", 1, now, "nope")).toBe(false);
    expect(await jobs.markDead("evt", "other", 1, "nope", now)).toBe(false);
    expect(await jobs.complete("evt", "owner")).toBe(true);
    expect(await jobs.countActive()).toBe(0);
  });

  it("reclaims an abandoned claim after its lease expires", async () => {
    const jobs = new InMemoryNotificationJobStore();
    const claimedAt = new Date("2026-11-21T12:00:00.000Z");
    await jobs.create({ eventId: "evt", event, nextAttemptAt: claimedAt });

    await jobs.claimDue({ workerId: "gone", now: claimedAt, limit: 1, leaseMs: 1_000 });
    expect(
      await jobs.claimDue({
        workerId: "next",
        now: new Date(claimedAt.getTime() + 500),
        limit: 1,
        leaseMs: 1_000,
      }),
    ).toHaveLength(0);

    const [reclaimed] = await jobs.claimDue({
      workerId: "next",
      now: new Date(claimedAt.getTime() + 1_001),
      limit: 1,
      leaseMs: 1_000,
    });
    expect(reclaimed.attempts).toBe(2);
  });

  it("prunes dead letters after the retention window", async () => {
    const jobs = new InMemoryNotificationJobStore();
    const now = new Date("2026-11-01T00:00:00.000Z");
    await jobs.create({ eventId: "evt", event, nextAttemptAt: now });
    await jobs.claimDue({ workerId: "w", now, limit: 1, leaseMs: 1_000 });
    await jobs.markDead("evt", "w", 1, "boom", now);

    expect(await jobs.pruneDeadLetters(new Date(now.getTime() - 1))).toBe(0);
    expect(await jobs.pruneDeadLetters(new Date(now.getTime() + 1))).toBe(1);
    expect(await jobs.listDeadLetters()).toHaveLength(0);
  });
});

describe("state machine integration", () => {
  it("enqueues events for funded, settled, rejected and admin-approved transitions only", () => {
    const enqueue = jest.fn();
    const effect = createNotificationDispatchEffect({ enqueue });

    void effect(transition(InvoiceStatus.FUNDED));
    void effect(transition(InvoiceStatus.SETTLED, "admin_settled"));
    void effect(transition(InvoiceStatus.REJECTED, "admin_rejected", "Bad docs"));
    void effect(transition(InvoiceStatus.PUBLISHED, "admin_approved"));
    void effect(transition(InvoiceStatus.PUBLISHED, "seller_published"));
    void effect(transition(InvoiceStatus.CANCELLED, "admin_cancelled"));

    expect(enqueue.mock.calls.map(([event]) => event.kind)).toEqual([
      "funded",
      "settled",
      "rejected",
      "approved",
    ]);
    expect(enqueue.mock.calls[2][0].reason).toBe("Bad docs");
  });

  it("keeps the seller effect for transitions the dispatcher does not own", async () => {
    const seller = jest.fn();
    const effect = unlessDispatched(seller);

    await effect(transition(InvoiceStatus.FUNDED));
    await effect(transition(InvoiceStatus.CANCELLED, "admin_cancelled"));

    expect(seller).toHaveBeenCalledTimes(1);
    expect(seller.mock.calls[0][0].to).toBe(InvoiceStatus.CANCELLED);
  });
});
