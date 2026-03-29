import type { NextFunction, Request, Response } from "express";
import type { AppLogger } from "../observability/logger";

import { AppError, HttpError } from "../utils/http-error";

export function notFoundMiddleware(
  _req: Request,
  _res: Response,
  next: NextFunction
) {
  next(new HttpError(404, "Route not found."));
}

export function createErrorMiddleware(logger: AppLogger) {
  return (
    error: unknown,
    req: Request,
    res: Response,
    _next: NextFunction
  ): void => {

    if (error instanceof AppError || error instanceof HttpError) {
      logger.warn("HTTP request failed.", {
        method: req.method,
        path: req.path,
        statusCode: error.statusCode,
        error: error.message,
      });

      res.status(error.statusCode).json({
        success: false,
        error: {
          code: error.code,
          message: error.message,
        },
      });

      return;
    }

    logger.error("Unhandled request error.", {
      method: req.method,
      path: req.path,
      statusCode: 500,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error.",
      },
    });
  };
}