import type { Request, Response, NextFunction, RequestHandler } from "express";

export type SecurityRouteGroup = "api" | "admin" | "webhook" | "health" | "web";

export interface RouteGroupHeaderExpectation {
  group: SecurityRouteGroup;
  contentSecurityPolicy: string;
  xFrameOptions: "DENY" | "SAMEORIGIN";
  xContentTypeOptions: "nosniff";
  referrerPolicy: string;
  permissionsPolicy: string;
  cacheControl?: string;
}

export interface SecurityHeaderPolicyConfig {
  nodeEnv?: string;
  hstsMaxAgeSeconds?: number;
  hstsIncludeSubDomains?: boolean;
  corsAllowedOrigins?: string[];
  corsAllowCredentials?: boolean;
  overrides?: Partial<Record<SecurityRouteGroup, Partial<RouteGroupHeaderExpectation>>>;
}

export class SecurityHeaderPolicyError extends Error {
  public readonly code = "SECURITY_HEADER_POLICY_DRIFT";

  constructor(message: string) {
    super(message);
    this.name = "SecurityHeaderPolicyError";
  }
}

export const DEFAULT_ROUTE_GROUP_POLICIES: Record<SecurityRouteGroup, RouteGroupHeaderExpectation> =
  {
    api: {
      group: "api",
      contentSecurityPolicy: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      xFrameOptions: "DENY",
      xContentTypeOptions: "nosniff",
      referrerPolicy: "no-referrer",
      permissionsPolicy: "geolocation=(), microphone=(), camera=()",
      cacheControl: "no-store",
    },
    admin: {
      group: "admin",
      contentSecurityPolicy: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      xFrameOptions: "DENY",
      xContentTypeOptions: "nosniff",
      referrerPolicy: "no-referrer",
      permissionsPolicy: "geolocation=(), microphone=(), camera=()",
      cacheControl: "no-store, private",
    },
    webhook: {
      group: "webhook",
      contentSecurityPolicy: "default-src 'none'; frame-ancestors 'none'",
      xFrameOptions: "DENY",
      xContentTypeOptions: "nosniff",
      referrerPolicy: "no-referrer",
      permissionsPolicy: "geolocation=(), microphone=(), camera=()",
      cacheControl: "no-store",
    },
    health: {
      group: "health",
      contentSecurityPolicy: "default-src 'none'; frame-ancestors 'none'",
      xFrameOptions: "DENY",
      xContentTypeOptions: "nosniff",
      referrerPolicy: "no-referrer",
      permissionsPolicy: "geolocation=(), microphone=(), camera=()",
      cacheControl: "no-store",
    },
    web: {
      group: "web",
      contentSecurityPolicy:
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
      xFrameOptions: "DENY",
      xContentTypeOptions: "nosniff",
      referrerPolicy: "strict-origin-when-cross-origin",
      permissionsPolicy: "geolocation=(), microphone=(), camera=()",
    },
  };

export function classifySecurityRouteGroup(pathname: string): SecurityRouteGroup {
  const normalized = pathname.toLowerCase();
  if (
    normalized.startsWith("/api/v1/admin") ||
    normalized.startsWith("/api/admin") ||
    normalized.startsWith("/admin")
  ) {
    return "admin";
  }
  if (normalized.includes("/webhook") || normalized.startsWith("/kyc")) {
    return "webhook";
  }
  if (
    normalized === "/health" ||
    normalized.startsWith("/health/") ||
    normalized === "/ready" ||
    normalized === "/metrics"
  ) {
    return "health";
  }
  if (normalized.startsWith("/api/") || normalized === "/api") {
    return "api";
  }
  return "web";
}

export function buildResolvedSecurityPolicies(
  config: SecurityHeaderPolicyConfig = {}
): Record<SecurityRouteGroup, RouteGroupHeaderExpectation> {
  const resolved = {} as Record<SecurityRouteGroup, RouteGroupHeaderExpectation>;
  for (const group of Object.keys(DEFAULT_ROUTE_GROUP_POLICIES) as SecurityRouteGroup[]) {
    resolved[group] = {
      ...DEFAULT_ROUTE_GROUP_POLICIES[group],
      ...(config.overrides?.[group] ?? {}),
      group,
    };
  }
  return resolved;
}

/**
 * Validates security header expectations at startup so missing or incompatible
 * directives fail fast before serving traffic.
 */
export function validateSecurityHeaderPolicy(config: SecurityHeaderPolicyConfig = {}): void {
  const nodeEnv = (config.nodeEnv ?? process.env.NODE_ENV ?? "development").trim();
  const hstsMaxAge = config.hstsMaxAgeSeconds ?? 31_536_000;

  if (nodeEnv === "production" && hstsMaxAge < 31_536_000) {
    throw new SecurityHeaderPolicyError(
      "Production HSTS max-age must be at least 31536000 seconds."
    );
  }

  if (config.corsAllowCredentials && config.corsAllowedOrigins?.some((o) => o.trim() === "*")) {
    throw new SecurityHeaderPolicyError(
      "Wildcard CORS origin '*' is incompatible with credentialed security policy."
    );
  }

  const policies = buildResolvedSecurityPolicies(config);
  for (const [group, policy] of Object.entries(policies) as Array<
    [SecurityRouteGroup, RouteGroupHeaderExpectation]
  >) {
    if (!policy.contentSecurityPolicy || !policy.contentSecurityPolicy.trim()) {
      throw new SecurityHeaderPolicyError(`Missing Content-Security-Policy for group '${group}'.`);
    }
    if (/unsafe-eval/i.test(policy.contentSecurityPolicy)) {
      throw new SecurityHeaderPolicyError(
        `Unsafe 'unsafe-eval' directive is forbidden in Content-Security-Policy for group '${group}'.`
      );
    }
    if (!/frame-ancestors\s+'none'/i.test(policy.contentSecurityPolicy)) {
      throw new SecurityHeaderPolicyError(
        `Content-Security-Policy for group '${group}' must include frame-ancestors 'none'.`
      );
    }
    if (policy.xContentTypeOptions !== "nosniff") {
      throw new SecurityHeaderPolicyError(
        `X-Content-Type-Options for group '${group}' must be 'nosniff'.`
      );
    }
    if (policy.xFrameOptions !== "DENY" && policy.xFrameOptions !== "SAMEORIGIN") {
      throw new SecurityHeaderPolicyError(`Invalid X-Frame-Options policy for group '${group}'.`);
    }
  }
}

/**
 * Express middleware applying deterministic route-group security headers while preserving CORS.
 */
export function createSecurityHeadersMiddleware(
  config: SecurityHeaderPolicyConfig = {}
): RequestHandler {
  validateSecurityHeaderPolicy(config);
  const policies = buildResolvedSecurityPolicies(config);
  const hstsMaxAge = config.hstsMaxAgeSeconds ?? 31_536_000;
  const includeSubDomains = config.hstsIncludeSubDomains ?? true;
  const hstsValue = includeSubDomains
    ? `max-age=${hstsMaxAge}; includeSubDomains`
    : `max-age=${hstsMaxAge}`;

  return (req: Request, res: Response, next: NextFunction): void => {
    const group = classifySecurityRouteGroup(req.path || req.url || "/");
    const policy = policies[group];

    res.setHeader("Content-Security-Policy", policy.contentSecurityPolicy);
    res.setHeader("Strict-Transport-Security", hstsValue);
    res.setHeader("X-Frame-Options", policy.xFrameOptions);
    res.setHeader("X-Content-Type-Options", policy.xContentTypeOptions);
    res.setHeader("Referrer-Policy", policy.referrerPolicy);
    res.setHeader("Permissions-Policy", policy.permissionsPolicy);
    if (policy.cacheControl && !res.getHeader("Cache-Control")) {
      res.setHeader("Cache-Control", policy.cacheControl);
    }

    next();
  };
}
