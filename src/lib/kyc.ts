import { KYCStatus } from "@/types/enums";

export function requireApprovedKYC(user: { kycStatus: KYCStatus }) {
  if (user.kycStatus !== KYCStatus.APPROVED) {
    const error: any = new Error("KYC not approved");
    error.status = 403;
    error.code = "KYC_NOT_APPROVED";
    throw error;
  }
}
