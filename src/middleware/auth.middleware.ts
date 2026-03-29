import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

import type { AuthService } from "../services/auth.service";
import type { AuthenticatedRequest } from "../types/auth";

import { HttpError } from "../utils/http-error";
import { UserType, KYCStatus } from "../types/enums";

interface AuthTokenPayload {
  sub: string;
  stellarAddress: string;
}

export function createAuthMiddleware(authService: AuthService) {
  return async (
    req: AuthenticatedRequest,
    _res: Response,
    next: NextFunction
  ): Promise<void> => {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      next(new HttpError(401, "Authorization token is required."));
      return;
    }

    const token = authHeader.slice(7);

    try {
      req.user = await authService.getCurrentUser(token);
      next();
    } catch {
      next(new HttpError(401, "Invalid or expired token."));
    }
  };
}

export function authenticateJWT(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    next(new HttpError(401, "Authorization token is required."));
    return;
  }

  const token = authHeader.slice(7);

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET missing");

    const payload = jwt.verify(token, secret) as AuthTokenPayload;

    (req as AuthenticatedRequest).user = {
      id: payload.sub,
      stellarAddress: payload.stellarAddress,
      email: null,
      userType: null as unknown as UserType,
      kycStatus: null as unknown as KYCStatus,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    next();
  } catch {
    next(new HttpError(401, "Invalid or expired token."));
  }
}