export interface CorsAuditRecord {
  version: number;
  action: "initialize" | "stage" | "promote" | "rollback";
  actor: string;
  timestamp: string;
  currentOrigins: string[];
  nextOrigins: string[];
  previousOrigins: string[] | null;
}

export interface CorsRotationSnapshot {
  version: number;
  allowCredentials: boolean;
  currentOrigins: string[];
  nextOrigins: string[];
  previousOrigins: string[] | null;
  effectiveOrigins: string[];
  updatedAt: string;
  auditTrail: CorsAuditRecord[];
}

export class CorsOriginValidationError extends Error {
  public readonly code = "INVALID_CORS_ORIGIN";
  public readonly invalidOrigins: string[];

  constructor(message: string, invalidOrigins: string[]) {
    super(message);
    this.name = "CorsOriginValidationError";
    this.invalidOrigins = invalidOrigins;
  }
}

export class CorsRotationStateError extends Error {
  public readonly code: string;

  constructor(message: string, code = "CORS_ROTATION_STATE_ERROR") {
    super(message);
    this.name = "CorsRotationStateError";
    this.code = code;
  }
}

/**
 * Validates and normalizes an explicit HTTP(S) origin. Rejects wildcards, `null`,
 * credentials, paths, query strings, fragments, and insecure HTTP in production.
 */
export function validateSingleCorsOrigin(raw: string, nodeEnv = "development"): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new CorsOriginValidationError("Empty CORS origin is not allowed.", [raw]);
  }
  if (trimmed === "*" || trimmed.includes("*")) {
    throw new CorsOriginValidationError(`Wildcard CORS origin '${trimmed}' is forbidden.`, [raw]);
  }
  if (trimmed.toLowerCase() === "null") {
    throw new CorsOriginValidationError("Literal 'null' CORS origin is forbidden.", [raw]);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CorsOriginValidationError(`Malformed CORS origin '${trimmed}'.`, [raw]);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new CorsOriginValidationError(`Unsupported scheme in CORS origin '${trimmed}'.`, [raw]);
  }

  if (parsed.username || parsed.password) {
    throw new CorsOriginValidationError(
      `Credentials are not permitted in CORS origin '${trimmed}'.`,
      [raw]
    );
  }

  if (
    (parsed.pathname && parsed.pathname !== "/") ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    trimmed.endsWith("/")
  ) {
    throw new CorsOriginValidationError(
      `CORS origin '${trimmed}' must not include a trailing slash, path, query, or hash.`,
      [raw]
    );
  }

  const isLocalhost =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (nodeEnv === "production" && parsed.protocol === "http:" && !isLocalhost) {
    throw new CorsOriginValidationError(
      `Insecure HTTP CORS origin '${trimmed}' is rejected in production.`,
      [raw]
    );
  }

  return parsed.origin;
}

/**
 * Validates and deduplicates a list of explicit CORS origins.
 */
export function validateCorsOriginList(
  origins: readonly string[],
  nodeEnv = "development"
): string[] {
  const invalid: string[] = [];
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const item of origins) {
    try {
      const clean = validateSingleCorsOrigin(item, nodeEnv);
      if (!seen.has(clean)) {
        seen.add(clean);
        normalized.push(clean);
      }
    } catch {
      invalid.push(item);
    }
  }

  if (invalid.length > 0) {
    throw new CorsOriginValidationError(
      `Invalid or wildcard CORS origins rejected: ${invalid.join(", ")}`,
      invalid
    );
  }

  return normalized;
}

export interface CorsOriginRotationManagerOptions {
  initialOrigins?: readonly string[];
  stagedNextOrigins?: readonly string[];
  allowCredentials?: boolean;
  nodeEnv?: string;
  onAudit?: (record: CorsAuditRecord) => void;
}

/**
 * Manages live current and staged-next CORS origin sets with atomic promotion,
 * rollback, and immutable audit history.
 */
export class CorsOriginRotationManager {
  private currentOrigins: string[];
  private nextOrigins: string[];
  private previousOrigins: string[] | null = null;
  private readonly allowCredentials: boolean;
  private readonly nodeEnv: string;
  private version = 1;
  private updatedAt: string;
  private readonly auditTrail: CorsAuditRecord[] = [];
  private readonly onAudit?: (record: CorsAuditRecord) => void;

  constructor(options: CorsOriginRotationManagerOptions = {}) {
    this.nodeEnv = (options.nodeEnv ?? process.env.NODE_ENV ?? "development").trim();
    this.allowCredentials = options.allowCredentials ?? false;
    this.onAudit = options.onAudit;
    this.currentOrigins = validateCorsOriginList(options.initialOrigins ?? [], this.nodeEnv);
    this.nextOrigins = validateCorsOriginList(options.stagedNextOrigins ?? [], this.nodeEnv);
    this.updatedAt = new Date().toISOString();

    this.recordAudit("initialize", "system");
  }

  private recordAudit(action: CorsAuditRecord["action"], actor: string): CorsAuditRecord {
    const rec: CorsAuditRecord = {
      version: this.version,
      action,
      actor,
      timestamp: this.updatedAt,
      currentOrigins: [...this.currentOrigins],
      nextOrigins: [...this.nextOrigins],
      previousOrigins: this.previousOrigins ? [...this.previousOrigins] : null,
    };
    this.auditTrail.push(rec);
    this.onAudit?.(rec);
    return rec;
  }

  public getEffectiveOrigins(): string[] {
    return Array.from(new Set([...this.currentOrigins, ...this.nextOrigins]));
  }

  public isOriginAllowed(origin: string | undefined): boolean {
    if (!origin) {
      return false;
    }
    const trimmed = origin.trim();
    return this.currentOrigins.includes(trimmed) || this.nextOrigins.includes(trimmed);
  }

  public getSnapshot(): CorsRotationSnapshot {
    return {
      version: this.version,
      allowCredentials: this.allowCredentials,
      currentOrigins: [...this.currentOrigins],
      nextOrigins: [...this.nextOrigins],
      previousOrigins: this.previousOrigins ? [...this.previousOrigins] : null,
      effectiveOrigins: this.getEffectiveOrigins(),
      updatedAt: this.updatedAt,
      auditTrail: this.auditTrail.map((a) => ({
        ...a,
        currentOrigins: [...a.currentOrigins],
        nextOrigins: [...a.nextOrigins],
        previousOrigins: a.previousOrigins ? [...a.previousOrigins] : null,
      })),
    };
  }

  /**
   * Stages a validated candidate `nextOrigins` set while keeping `currentOrigins` active.
   */
  public stageNextOrigins(nextOrigins: readonly string[], actor: string): CorsRotationSnapshot {
    if (nextOrigins.length === 0) {
      throw new CorsOriginValidationError(
        "Staged nextOrigins must contain at least one valid origin.",
        []
      );
    }
    const validated = validateCorsOriginList(nextOrigins, this.nodeEnv);
    this.nextOrigins = validated;
    this.version += 1;
    this.updatedAt = new Date().toISOString();
    this.recordAudit("stage", actor);
    return this.getSnapshot();
  }

  /**
   * Promotes staged `nextOrigins` to `currentOrigins`, retaining the prior set for rollback.
   */
  public promoteStagedOrigins(actor: string): CorsRotationSnapshot {
    if (this.nextOrigins.length === 0) {
      throw new CorsRotationStateError(
        "Cannot promote CORS origins when no staged nextOrigins set exists.",
        "NO_STAGED_ORIGINS"
      );
    }
    this.previousOrigins = [...this.currentOrigins];
    this.currentOrigins = [...this.nextOrigins];
    this.nextOrigins = [];
    this.version += 1;
    this.updatedAt = new Date().toISOString();
    this.recordAudit("promote", actor);
    return this.getSnapshot();
  }

  /**
   * Rolls back to `previousOrigins` if a promotion occurred, or clears staged `nextOrigins`.
   */
  public rollback(actor: string): CorsRotationSnapshot {
    if (this.previousOrigins !== null) {
      this.currentOrigins = [...this.previousOrigins];
      this.previousOrigins = null;
      this.nextOrigins = [];
    } else if (this.nextOrigins.length > 0) {
      this.nextOrigins = [];
    } else {
      throw new CorsRotationStateError(
        "No previous or staged CORS origin set is available to roll back.",
        "NO_ROLLBACK_TARGET"
      );
    }
    this.version += 1;
    this.updatedAt = new Date().toISOString();
    this.recordAudit("rollback", actor);
    return this.getSnapshot();
  }
}
