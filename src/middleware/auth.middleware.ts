import type { NextFunction, Request, Response } from "express";

import type { AuthService } from "../services/auth.service";
import { HttpError } from "../utils/http-error";

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
    const authorizationHeader = req.headers.authorization;

    if (!authorizationHeader?.startsWith("Bearer ")) {
      next(new HttpError(401, "Authorization token is required."));
      return;
    }

    const token = authorizationHeader.slice("Bearer ".length).trim();

    if (!token) {
      next(new HttpError(401, "Authorization token is required."));
      return;
    }

    try {
      req.user = await authService.getCurrentUser(token);
      next();
    } catch (error) {
      next(error);
    }
  };


export function authenticateJWT(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const authorizationHeader = req.headers.authorization;

  if (!authorizationHeader?.startsWith("Bearer ")) {
    next(new HttpError(401, "Authorization token is required."));
    return;
  }

  const token = authorizationHeader.slice("Bearer ".length).trim();

  if (!token) {
    next(new HttpError(401, "Authorization token is required."));
    return;
  }

  try {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new Error("JWT_SECRET not configured");
    }

    const payload = jwt.verify(token, jwtSecret) as AuthTokenPayload;

    if (!payload.sub || !payload.stellarAddress) {
      next(new HttpError(401, "Invalid token payload."));
      return;
    }

    // Create a minimal user object for the request
    // The full user data would be fetched from the database if needed
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
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      next(new HttpError(401, "Invalid or expired token."));
      return;
    }
    next(error);
  }
}