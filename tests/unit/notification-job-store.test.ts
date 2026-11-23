import "reflect-metadata";
import { DataSource, getMetadataArgsStorage } from "typeorm";
import { NotificationDispatchJob } from "../../src/models/NotificationDispatchJob.model";
import { TypeOrmNotificationJobStore } from "../../src/services/notification-job-store.service";

const invoice = { id: "inv-1", sellerId: "seller-1", invoiceNumber: "INV-001" };
const event = { kind: "funded" as const, invoice };

/** Mirrors the repo's SQLite test convention for Postgres-only column types. */
function patchEntityMetadataForSQLite(): void {
  const columns = getMetadataArgsStorage().columns;
  for (const col of columns) {
    if (col.options.type === "timestamptz") {
      col.options.type = "datetime" as typeof col.options.type;
    }
    if (col.options.type === "jsonb") {
      col.options.type = "text" as typeof col.options.type;
    }
  }
}

describe("TypeOrmNotificationJobStore", () => {
  let dataSource: DataSource;
  let store: TypeOrmNotificationJobStore;

  beforeEach(async () => {
    patchEntityMetadataForSQLite();
    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [NotificationDispatchJob],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    store = new TypeOrmNotificationJobStore(dataSource);
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it("persists a job before acknowledgement and survives a new store instance", async () => {
    const now = new Date("2026-11-21T12:00:00.000Z");

    expect(await store.create({ eventId: "evt", event, nextAttemptAt: now })).toBe(true);
    expect(await store.create({ eventId: "evt", event, nextAttemptAt: now })).toBe(false);

    // A replacement process connects to the same database.
    const replacement = new TypeOrmNotificationJobStore(dataSource);
    expect(await replacement.countActive()).toBe(1);

    const [claimed] = await replacement.claimDue({
      workerId: "worker-b",
      now,
      limit: 1,
      leaseMs: 60_000,
    });
    expect(claimed).toMatchObject({ eventId: "evt", attempts: 1, claimedBy: "worker-b" });
  });

  it("lets only one of two racing workers claim a due job", async () => {
    const now = new Date("2026-11-21T12:00:00.000Z");
    await store.create({ eventId: "evt", event, nextAttemptAt: now });

    const a = new TypeOrmNotificationJobStore(dataSource);
    const b = new TypeOrmNotificationJobStore(dataSource);
    const [claimedA, claimedB] = await Promise.all([
      a.claimDue({ workerId: "a", now, limit: 1, leaseMs: 60_000 }),
      b.claimDue({ workerId: "b", now, limit: 1, leaseMs: 60_000 }),
    ]);

    expect(claimedA.length + claimedB.length).toBe(1);
    expect(await store.countActive()).toBe(1);
  });

  it("persists attempts and next-attempt time, then dead-letters and replays", async () => {
    const now = new Date("2026-11-21T12:00:00.000Z");
    await store.create({ eventId: "evt", event, nextAttemptAt: now });
    await store.claimDue({ workerId: "a", now, limit: 1, leaseMs: 60_000 });

    const retryAt = new Date(now.getTime() + 5_000);
    expect(await store.reschedule("evt", "a", 1, retryAt, "db unavailable")).toBe(true);

    const replacement = new TypeOrmNotificationJobStore(dataSource);
    expect(await replacement.claimDue({ workerId: "b", now, limit: 1, leaseMs: 60_000 })).toHaveLength(
      0
    );
    expect(await replacement.nextRunAt(60_000)).toEqual(retryAt);

    const [second] = await replacement.claimDue({
      workerId: "b",
      now: retryAt,
      limit: 1,
      leaseMs: 60_000,
    });
    expect(second.attempts).toBe(2);
    expect(await replacement.markDead("evt", "b", 2, "db unavailable", retryAt)).toBe(true);

    const dead = await replacement.listDeadLetters();
    expect(dead).toEqual([
      expect.objectContaining({ eventId: "evt", attempts: 2, error: "db unavailable" }),
    ]);

    expect(await replacement.replayDeadLetter("evt", retryAt)).toBe(true);
    expect(await replacement.countActive()).toBe(1);
    expect(await replacement.listDeadLetters()).toHaveLength(0);
  });

  it("releases an abandoned claim and prunes dead letters past retention", async () => {
    const claimedAt = new Date("2026-11-21T12:00:00.000Z");
    await store.create({ eventId: "evt", event, nextAttemptAt: claimedAt });
    await store.claimDue({ workerId: "gone", now: claimedAt, limit: 1, leaseMs: 1_000 });

    expect(
      await store.recoverExpiredLeases({ now: new Date(claimedAt.getTime() + 500), leaseMs: 1_000 })
    ).toBe(0);
    expect(
      await store.recoverExpiredLeases({
        now: new Date(claimedAt.getTime() + 1_001),
        leaseMs: 1_000,
      })
    ).toBe(1);

    await store.claimDue({
      workerId: "w",
      now: new Date(claimedAt.getTime() + 1_001),
      limit: 1,
      leaseMs: 1_000,
    });
    await store.markDead("evt", "w", 2, "boom", claimedAt);

    expect(await store.pruneDeadLetters(new Date(claimedAt.getTime() - 1))).toBe(0);
    expect(await store.pruneDeadLetters(new Date(claimedAt.getTime() + 1))).toBe(1);
    expect(await store.countActive()).toBe(0);
  });
});
