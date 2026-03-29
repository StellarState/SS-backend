// src/types/auth.ts
import type { Request } from "express";
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

// Existing user type
export interface AuthenticatedRequestUser extends PublicUser {}

// New: strongly typed Request with optional user
export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedRequestUser;
}