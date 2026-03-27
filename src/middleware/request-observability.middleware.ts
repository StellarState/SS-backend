import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import type { AppLogger } from "../observability/logger";
import type { MetricsRegistry } from "../observability/metrics";

interface RequestObservabilityDependencies {
  logger: AppLogger;
  metricsEnabled: boolean;
  metricsRegistry: MetricsRegistry;
}

function resolveRoutePrefix(req: Request): string {
  if (req.routeBasePath) {
    return req.routeBasePath;
  }

  if (req.baseUrl) {
    return req.baseUrl;
  }

  const originalPath = req.originalUrl.split("?")[0];

  if (!req.path || !originalPath.endsWith(req.path)) {
    return "";
  }

  return originalPath.slice(0, originalPath.length - req.path.length);
}

function resolveRouteLabel(req: Request): string {
  const routePath = req.route?.path;

  if (!routePath) {
    return "unmatched";
  }

  const normalizedRoutePath = Array.isArray(routePath) ? routePath[0] : routePath;
  const route = `${resolveRoutePrefix(req)}${normalizedRoutePath}`;

  return route || "/";
}

function resolveRequestId(requestIdHeader: string | string[] | undefined): string {
  if (typeof requestIdHeader === "string" && requestIdHeader.trim()) {
    return requestIdHeader.trim();
  }

  return randomUUID();
}

export function createRequestObservabilityMiddleware(
  dependencies: RequestObservabilityDependencies,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = resolveRequestId(req.header("x-request-id"));
    const startedAt = process.hrtime.bigint();

    req.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const route = resolveRouteLabel(req);
      const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
      const metadata = {
        requestId,
        method: req.method,
        route,
        statusCode: res.statusCode,
        statusClass,
        durationMs: Number(durationMs.toFixed(3)),
      };

      dependencies.logger.info("HTTP request completed.", metadata);

      if (dependencies.metricsEnabled) {
        dependencies.metricsRegistry.recordHttpRequest({
          method: req.method,
          route,
          statusClass,
          durationMs,
        });
      }
    });

    next();
  };
}
