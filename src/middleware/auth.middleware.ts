import type { Request, Response, NextFunction } from "express";
import type { AuthService } from "../services/auth.service";
import { HttpError } from "../utils/http-error";
import type { AuthenticatedRequestUser } from "../types/auth";

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedRequestUser;
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
}