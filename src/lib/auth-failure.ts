import jwt from "jsonwebtoken";

export type AuthFailureReason =
  | "missing_token"
  | "expired_token"
  | "invalid_signature"
  | "invalid_token"
  | "unparseable_token";

export interface AuthFailureDetails {
  reason: AuthFailureReason;
  truncatedAddress: string | null;
  failedAt: string;
}

export function truncateWalletAddress(
  address: string | null | undefined,
): string | null {
  if (!address) {
    return null;
  }

  if (address.length <= 8) {
    return address;
  }

  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

export function extractWalletFromUnverifiedToken(token?: string): string | null {
  if (!token) {
    return null;
  }

  const decoded = jwt.decode(token);
  if (!decoded || typeof decoded === "string") {
    return null;
  }

  const sub = decoded.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : null;
}

export function buildAuthFailureDetails(
  token: string | undefined,
  reason: AuthFailureReason,
): { authFailure: AuthFailureDetails } {
  return {
    authFailure: {
      reason,
      truncatedAddress: truncateWalletAddress(
        extractWalletFromUnverifiedToken(token),
      ),
      failedAt: new Date().toISOString(),
    },
  };
}

export function classifyJwtError(error: unknown): AuthFailureReason {
  if (error instanceof jwt.TokenExpiredError) {
    return "expired_token";
  }

  if (error instanceof jwt.JsonWebTokenError) {
    return "invalid_signature";
  }

  return "invalid_token";
}
