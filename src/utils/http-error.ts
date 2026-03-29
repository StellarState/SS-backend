export interface ErrorPayload {
  code: string;
  message: string;
}

export interface ApiResponseEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: ErrorPayload;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
  };
}

export class AppError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(statusCode: number, message: string, code: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class HttpError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = `HTTP_${statusCode}`;
    this.details = details;
  }
}
