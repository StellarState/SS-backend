import { KYCStatus, UserType } from "./enums";

export interface PublicUser {
  id: string;
  stellarAddress: string;
  email: string | null;
  userType: UserType;
  kycStatus: KYCStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthenticatedRequestUser extends PublicUser {}
