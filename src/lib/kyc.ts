import { KYCStatus } from "@/types/enums";

export class KYCError extends Error {
  status: number;
  code: string;

  constructor(message: string, code = "KYC_NOT_APPROVED", status = 403) {
    super(message);
    this.name = "KYCError";
    this.code = code;
    this.status = status;
  }
}

export function requireApprovedKYC(user: { kycStatus: KYCStatus }) {
  if (user.kycStatus !== KYCStatus.APPROVED) {
    throw new KYCError("KYC not approved");
  }
}