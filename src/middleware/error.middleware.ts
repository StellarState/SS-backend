import type { NextFunction, Request, Response } from "express";
import type { AppLogger } from "../observability/logger";
import { HttpError } from "../utils/http-error";

export function notFoundMiddleware(_req: Request, _res: Response, next: NextFunction) {
  next(new HttpError(404, "Route not found."));
}

export function createErrorMiddleware(logger: AppLogger) {
  return (
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    void next;

    if (error instanceof HttpError) {
      logger.warn("HTTP request failed.", {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        statusCode: error.statusCode,
        error: error.message,
      });
      res.status(error.statusCode).json({
        error: error.message,
        details: error.details,
      });
      return;
    }

    logger.error("Unhandled request error.", {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      statusCode: 500,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    res.status(500).json({
      error: "Internal server error.",
    });
  };
}
