import { requireApprovedKYC } from "@/lib/kyc";
import { KYCStatus } from "@/types/enums";

describe("KYC check", () => {
  it("blocks non-approved users", () => {
    expect(() =>
      requireApprovedKYC({ kycStatus: KYCStatus.PENDING })
    ).toThrow();
  });

  it("allows approved users", () => {
    expect(() =>
      requireApprovedKYC({ kycStatus: KYCStatus.APPROVED })
    ).not.toThrow();
  });
});