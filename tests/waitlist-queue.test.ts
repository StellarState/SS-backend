import { DataSource } from "typeorm";
import { CommunityProgramsService } from "../src/services/community-programs.service";
import { WaitlistService } from "../src/services/waitlist.service";
import { WaitlistEntry } from "../src/models/WaitlistEntry.model";

describe("referral-aware waitlist queue", () => {
  let dataSource: DataSource;
  let communityPrograms: CommunityProgramsService;
  let waitlist: WaitlistService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [WaitlistEntry],
      synchronize: true,
    });
    await dataSource.initialize();
    communityPrograms = new CommunityProgramsService(dataSource);
    waitlist = new WaitlistService(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.getRepository(WaitlistEntry).clear();
  });

  async function addEntry(
    wallet: string,
    referralCount = 0,
    createdAt?: Date,
  ): Promise<WaitlistEntry> {
    const repository = dataSource.getRepository(WaitlistEntry);
    const entry = repository.create({
      wallet,
      email: `${wallet.toLowerCase()}@example.com`,
      referralCode: `${wallet}-code`,
      referralCount,
      status: "pending",
      ...(createdAt ? { createdAt } : {}),
    });
    return repository.save(entry);
  }

  it("assigns distinct ordinal positions and keeps them when a later signup joins", async () => {
    const first = await addEntry("GWALLET1", 0, new Date("2026-01-01T00:00:00Z"));
    const second = await addEntry("GWALLET2", 0, new Date("2026-01-02T00:00:00Z"));
    const third = await addEntry("GWALLET3", 0, new Date("2026-01-03T00:00:00Z"));

    expect((await communityPrograms.waitlistView(first)).position).toBe(1);
    expect((await communityPrograms.waitlistView(second)).position).toBe(2);
    expect((await communityPrograms.waitlistView(third)).position).toBe(3);

    const later = await addEntry("GWALLET4", 0, new Date("2026-01-04T00:00:00Z"));
    expect((await communityPrograms.waitlistView(first)).position).toBe(1);
    expect((await communityPrograms.waitlistView(second)).position).toBe(2);
    expect((await communityPrograms.waitlistView(third)).position).toBe(3);
    expect((await communityPrograms.waitlistView(later)).position).toBe(4);
  });

  it("uses referral priority with stable signup-order ties for both listing and bulk approval", async () => {
    const first = await addEntry("GWALLET1", 1, new Date("2026-01-01T00:00:00Z"));
    const second = await addEntry("GWALLET2", 3, new Date("2026-01-02T00:00:00Z"));
    const third = await addEntry("GWALLET3", 3, new Date("2026-01-03T00:00:00Z"));

    const queue = await waitlist.getWaitlistQueue();
    expect(queue.entries.map((entry) => entry.wallet)).toEqual([
      second.wallet,
      third.wallet,
      first.wallet,
    ]);
    expect((await communityPrograms.waitlistView(second)).position).toBe(1);
    expect((await communityPrograms.waitlistView(third)).position).toBe(2);

    const approved = await waitlist.bulkApproveTop(2);
    expect(approved.map((entry) => entry.wallet)).toEqual([
      second.wallet,
      third.wallet,
    ]);
    expect((await communityPrograms.waitlistView(second)).position).toBeNull();
  });
});
