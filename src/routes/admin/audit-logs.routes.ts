import { Router, type NextFunction, type Request, type Response } from "express";
import { createAuthMiddleware } from "@/middleware/auth.middleware";
import { requireAdminRole } from "@/middleware/require-admin-role.middleware";
import type { AuthService } from "@/services/auth.service";
import type { AuditService } from "@/services/audit-log.service";
import { AppError } from "@/utils/http-error";

export interface AdminAuditLogsRouterDeps {
  auditService: AuditService;
  authService?: AuthService;
  enforceAuth?: boolean;
}

function validateCursor(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) {
    throw new AppError(400, "cursor must be a non-negative integer id.", "INVALID_CURSOR");
  }
  return value;
}

function validateLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 1 || num > 100) {
    throw new AppError(400, "limit must be an integer between 1 and 100.", "INVALID_LIMIT");
  }
  return num;
}

export function createAdminAuditLogsRouter({
  auditService,
  authService,
  enforceAuth = false,
}: AdminAuditLogsRouterDeps): Router {
  const router = Router();

  if (enforceAuth) {
    const requireAdminRoleMiddleware = requireAdminRole();
    router.use((req: Request, res: Response, next: NextFunction): void => {
      const adminKey = req.headers["x-admin-key"];
      if (adminKey && process.env.ADMIN_API_KEY && adminKey === process.env.ADMIN_API_KEY) {
        next();
        return;
      }
      if (!authService) {
        requireAdminRoleMiddleware(req, res, next);
        return;
      }
      const authMiddleware = createAuthMiddleware(authService);
      authMiddleware(req, res, (err?: unknown) => {
        if (err) {
          next(err);
          return;
        }
        requireAdminRoleMiddleware(req, res, next);
      });
    });
  }

  router.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = await auditService.list({
        actor: typeof req.query.actor === "string" ? req.query.actor : undefined,
        action: typeof req.query.action === "string" ? req.query.action : undefined,
        resource: typeof req.query.resource === "string" ? req.query.resource : undefined,
        cursor: validateCursor(req.query.cursor),
        limit: validateLimit(req.query.limit),
      });

      res.status(200).json({
        success: true,
        data: page.items,
        meta: {
          limit: page.limit,
          hasNextPage: page.hasNextPage,
          nextCursor: page.nextCursor,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/verify", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const verification = await auditService.verifyChain();
      res.status(200).json({
        success: true,
        data: verification,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
