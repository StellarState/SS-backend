import type { NextFunction, Request, Response } from "express";
import type { AppLogger } from "../observability/logger";
import type { ApiResponseEnvelope } from "../utils/http-error";
import { AppError, HttpError } from "../utils/http-error";

export function notFoundMiddleware(_req: Request, _res: Response, next: NextFunction) {
  next(new HttpError(404, "Route not found."));
}

function sendEnvelopeResponse<T>(res: Response, statusCode: number, payload: ApiResponseEnvelope<T>) {
  res.status(statusCode).json(payload);
}

export function createErrorMiddleware(logger: AppLogger) {
  return (
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    void next;

    if (error instanceof AppError || error instanceof HttpError) {
      logger.warn("HTTP request failed.", {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        statusCode: error.statusCode,
        code: error.code,
        error: error.message,
      });

      const envelope: ApiResponseEnvelope = {
        success: false,
        error: {
          code: error.code,
          message: error.message,
        },
      };

      sendEnvelopeResponse(res, error.statusCode, envelope);
      return;
    }

    logger.error("Unhandled request error.", {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      statusCode: 500,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    const envelope: ApiResponseEnvelope = {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error.",
      },
    };

    sendEnvelopeResponse(res, 500, envelope);
  };
}
