import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../utils/http-error";

export function notFoundMiddleware(_req: Request, _res: Response, next: NextFunction) {
  next(new HttpError(404, "Route not found."));
}

export function errorMiddleware(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  void next;

  if (error instanceof HttpError) {
    res.status(error.statusCode).json({
      error: error.message,
      details: error.details,
    });
    return;
  }

  res.status(500).json({
    error: "Internal server error.",
  });
}
