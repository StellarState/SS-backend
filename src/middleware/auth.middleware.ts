import type { NextFunction, Request, Response } from "express";
import type { AuthService } from "../services/auth.service";
import { HttpError } from "../utils/http-error";

export function createAuthMiddleware(authService: AuthService) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
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
