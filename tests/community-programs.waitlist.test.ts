import { DataSource } from "typeorm";
import { CommunityProgramsService } from "../src/services/community-programs.service";
import { WaitlistEntry } from "../src/models/WaitlistEntry.model";
import { WaitlistReferralCredit } from "../src/models/WaitlistReferralCredit.model";

describe("CommunityProgramsService waitlist referrals", () => {
  let dataSource: DataSource;
  let service: CommunityProgramsService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [WaitlistEntry, WaitlistReferralCredit],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    service = new CommunityProgramsService(dataSource);
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it("credits a qualifying signup once and returns a stable duplicate response", async () => {
    const referrer = await service.registerWaitlist("GREFERRER", "referrer@example.com");
    const signup = await service.registerWaitlist("GSIGNUP", "signup@example.com", referrer.referralCode);

    expect(signup.created).toBe(true);
    expect(signup.referralStatus).toBe("credited");
    expect(await dataSource.getRepository(WaitlistEntry).findOneByOrFail({ wallet: "GREFERRER" }))
      .toMatchObject({ referralCount: 1 });
    expect(await dataSource.getRepository(WaitlistReferralCredit).countBy({ signupWallet: "GSIGNUP" })).toBe(1);

    const duplicateSignup = await service.registerWaitlist("GSIGNUP", "signup@example.com", referrer.referralCode);
    expect(duplicateSignup.created).toBe(false);
    expect(duplicateSignup.referralStatus).toBe("already_credited");
    expect(duplicateSignup.referralCode).toBe(signup.referralCode);
    expect(await dataSource.getRepository(WaitlistEntry).findOneByOrFail({ wallet: "GREFERRER" }))
      .toMatchObject({ referralCount: 1 });
    expect(await dataSource.getRepository(WaitlistReferralCredit).countBy({ signupWallet: "GSIGNUP" })).toBe(1);
  });

  it("does not grant priority for unknown or self-referral codes", async () => {
    const unknown = await service.registerWaitlist("GUNKNOWN", "unknown@example.com", "missing-code");
    expect(unknown.referralStatus).toBe("unknown_code");
    expect(unknown.referralCount).toBe(0);

    const selfReferral = await service.registerWaitlist(
      "GUNKNOWN",
      "unknown@example.com",
      unknown.referralCode,
    );
    expect(selfReferral.created).toBe(false);
    expect(selfReferral.referralStatus).toBe("self_referral");
    expect(await dataSource.getRepository(WaitlistReferralCredit).count()).toBe(0);
    expect(await dataSource.getRepository(WaitlistEntry).findOneByOrFail({ wallet: "GUNKNOWN" }))
      .toMatchObject({ referralCount: 0 });
  });

  it("uses the signup wallet as the referral event identity", async () => {
    const referrer = await service.registerWaitlist("GREFERRER", "referrer@example.com");
    await service.registerWaitlist("GSIGNUP", "signup@example.com", referrer.referralCode);

    await expect(service.recordWaitlistReferral(referrer.referralCode, "GSIGNUP"))
      .resolves.toEqual({ recorded: false, reason: "already_recorded" });
    await expect(service.recordWaitlistReferral(referrer.referralCode, "GUNKNOWN"))
      .resolves.toEqual({ recorded: false, reason: "signup_not_found" });
    await expect(service.recordWaitlistReferral("invalid-code", "GSIGNUP"))
      .resolves.toEqual({ recorded: false, reason: "unknown_code" });
    await expect(service.recordWaitlistReferral(referrer.referralCode, "GREFERRER"))
      .resolves.toEqual({ recorded: false, reason: "self_referral" });
    expect(await dataSource.getRepository(WaitlistEntry).findOneByOrFail({ wallet: "GREFERRER" }))
      .toMatchObject({ referralCount: 1 });
  });

  it("rolls back signup and credit if updating the referrer fails", async () => {
    const referrer = await service.registerWaitlist("GREFERRER", "referrer@example.com");
    await dataSource.query(`
      CREATE TRIGGER reject_referral_count
      BEFORE UPDATE OF referral_count ON waitlist_entries
      WHEN OLD.wallet = 'GREFERRER'
      BEGIN
        SELECT RAISE(ABORT, 'referral count update rejected');
      END
    `);

    await expect(service.registerWaitlist("GSIGNUP", "signup@example.com", referrer.referralCode))
      .rejects.toThrow("referral count update rejected");
    expect(await dataSource.getRepository(WaitlistEntry).findOneBy({ wallet: "GSIGNUP" })).toBeNull();
    expect(await dataSource.getRepository(WaitlistReferralCredit).count()).toBe(0);
    expect(await dataSource.getRepository(WaitlistEntry).findOneByOrFail({ wallet: "GREFERRER" }))
      .toMatchObject({ referralCount: 0 });
  });

  it("credits concurrent retries for the same signup only once", async () => {
    const referrer = await service.registerWaitlist("GREFERRER", "referrer@example.com");

    await Promise.all([
      service.registerWaitlist("GSIGNUP", "signup@example.com", referrer.referralCode),
      service.registerWaitlist("GSIGNUP", "signup@example.com", referrer.referralCode),
    ]);

    expect(await dataSource.getRepository(WaitlistEntry).findOneByOrFail({ wallet: "GREFERRER" }))
      .toMatchObject({ referralCount: 1 });
    expect(await dataSource.getRepository(WaitlistReferralCredit).countBy({ signupWallet: "GSIGNUP" })).toBe(1);
  });
});
