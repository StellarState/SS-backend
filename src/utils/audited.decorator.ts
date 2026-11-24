import type { Request, Response } from "express";
import type { AuthenticatedRequest } from "@/types/auth";
import { logger } from "@/observability/logger";
import {
  type AuditService,
  getActiveAuditService,
  sanitizeAuditPayload,
} from "@/services/audit-log.service";

export interface AuditedDecoratorOptions {
  service?: () => AuditService;
}

function resolveActor(req: Request): string {
  const authReq = req as AuthenticatedRequest;
  if (authReq.user?.stellarAddress) return authReq.user.stellarAddress;
  if (authReq.user?.id) return authReq.user.id;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.reviewerId === "string" && body.reviewerId.trim()) {
    return body.reviewerId.trim();
  }
  if (req.headers?.["x-admin-key"]) {
    return "admin-key";
  }
  return "anonymous";
}

function resolveResource(req: Request, fallbackAction: string): string {
  const candidate = req.originalUrl || `${req.baseUrl ?? ""}${req.path ?? ""}`.trim();
  if (!candidate) return fallbackAction;
  const qIndex = candidate.indexOf("?");
  return qIndex >= 0 ? candidate.slice(0, qIndex) : candidate;
}

/**
 * Controller method decorator that records an append-only SHA-256 hash-chained
 * audit entry containing actor, route, and sanitized request payload (#869).
 */
export function Audited(action: string, options?: AuditedDecoratorOptions): MethodDecorator {
  return function <T>(
    _target: object,
    _propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<T>
  ): TypedPropertyDescriptor<T> {
    const original = descriptor.value as unknown as ((...args: unknown[]) => unknown) | undefined;
    if (typeof original !== "function") {
      return descriptor;
    }

    (descriptor as TypedPropertyDescriptor<unknown>).value = async function (
      this: unknown,
      ...args: unknown[]
    ) {
      const req = args[0] as Request | undefined;
      const res = args[1] as Response | undefined;
      const result = await original.apply(this, args);

      const statusCode = typeof res?.statusCode === "number" ? res.statusCode : 200;
      if (req && statusCode < 400) {
        try {
          const auditService = options?.service ? options.service() : getActiveAuditService();
          const sanitizedBody = sanitizeAuditPayload(req.body ?? null) as Record<
            string,
            unknown
          > | null;
          const params =
            req.params && Object.keys(req.params).length > 0
              ? (sanitizeAuditPayload(req.params) as Record<string, unknown>)
              : undefined;
          const afterPayload: Record<string, unknown> | null =
            params !== undefined ? { ...(sanitizedBody ?? {}), params } : sanitizedBody;

          await auditService.record({
            actor: resolveActor(req),
            action,
            resource: resolveResource(req, action),
            before: null,
            after: afterPayload,
          });
        } catch (auditErr) {
          logger.error("audit.decorator_record_failed", {
            action,
            error: auditErr instanceof Error ? auditErr.message : String(auditErr),
          });
        }
      }

      return result;
    };

    return descriptor;
  };
}
