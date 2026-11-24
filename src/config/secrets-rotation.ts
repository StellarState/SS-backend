import type { AppLogger } from "../observability/logger";

export type SecretSourceClass = "env_var" | "file_mount" | "keyring" | "unset";

export type SecretRotationState = "fresh" | "warning" | "stale" | "missing";

export interface ManagedSecretDescriptor {
  /** Logical identifier (never the secret value), e.g. "JWT_SECRET". */
  key: string;
  /** Optional env key recording ISO-8601 or epoch-ms rotation timestamp. */
  rotatedAtKey?: string;
  /** Optional env key pointing to a mounted secret file path. */
  fileKey?: string;
  /** Whether the secret is required for service operation. */
  required: boolean;
  /** Maximum age in days before the secret is marked stale. */
  maxAgeDays: number;
  /** Age threshold in days before emitting a rotation warning. */
  warnAfterDays: number;
}

export interface SecretStatusMetadata {
  key: string;
  required: boolean;
  configured: boolean;
  sourceClass: SecretSourceClass;
  state: SecretRotationState;
  rotatedAt: string | null;
  ageDays: number | null;
  warnAfterDays: number;
  maxAgeDays: number;
}

export interface SecretPolicyReport {
  checkedAt: string;
  nodeEnv: string;
  healthy: boolean;
  staleCount: number;
  warningCount: number;
  missingRequiredCount: number;
  placeholderKeys: string[];
  secrets: SecretStatusMetadata[];
}

export class SecretPolicyError extends Error {
  public readonly code = "SECRET_POLICY_VIOLATION";
  public readonly violatingKeys: string[];

  constructor(message: string, violatingKeys: string[]) {
    super(message);
    this.name = "SecretPolicyError";
    this.violatingKeys = violatingKeys;
  }
}

export const DEFAULT_MANAGED_SECRETS: readonly ManagedSecretDescriptor[] = [
  {
    key: "JWT_SECRET",
    rotatedAtKey: "JWT_SECRET_ROTATED_AT",
    fileKey: "JWT_SECRET_FILE",
    required: true,
    maxAgeDays: 90,
    warnAfterDays: 75,
  },
  {
    key: "IPFS_JWT",
    rotatedAtKey: "IPFS_JWT_ROTATED_AT",
    fileKey: "IPFS_JWT_FILE",
    required: true,
    maxAgeDays: 90,
    warnAfterDays: 75,
  },
  {
    key: "KYC_WEBHOOK_SECRET",
    rotatedAtKey: "KYC_WEBHOOK_SECRET_ROTATED_AT",
    fileKey: "KYC_WEBHOOK_SECRET_FILE",
    required: false,
    maxAgeDays: 90,
    warnAfterDays: 75,
  },
  {
    key: "ADMIN_API_KEY",
    rotatedAtKey: "ADMIN_API_KEY_ROTATED_AT",
    fileKey: "ADMIN_API_KEY_FILE",
    required: false,
    maxAgeDays: 60,
    warnAfterDays: 45,
  },
  {
    key: "DATABASE_PASSWORD",
    rotatedAtKey: "DATABASE_PASSWORD_ROTATED_AT",
    fileKey: "DATABASE_PASSWORD_FILE",
    required: false,
    maxAgeDays: 90,
    warnAfterDays: 75,
  },
];

const PLACEHOLDER_EXACT = new Set([
  "changeme",
  "change_me",
  "change-me",
  "placeholder",
  "your-secret-here",
  "your_secret_here",
  "your_jwt_secret",
  "your-jwt-secret",
  "replace_me",
  "replace-me",
  "secret",
  "secret123",
  "password",
  "password123",
  "admin",
  "admin123",
  "default",
  "default_secret",
  "example",
  "example_secret",
  "todo",
  "xxx",
  "xxxx",
  "test_secret_change_me",
]);

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^<[^>]+>$/,
  /^\$\{[A-Z0-9_]+\}$/,
  /^(your|replace|insert|enter|dummy|sample|example)[-_][a-z0-9_-]*$/i,
  /changeme|replace_with_|your_secret|todo_secret/i,
];

/**
 * Detects known placeholder or dummy credential values without exposing the raw value.
 */
export function isPlaceholderSecretValue(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_EXACT.has(lower)) {
    return true;
  }
  if (PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed))) {
    return true;
  }
  if (trimmed.length >= 8 && new Set(trimmed.split("")).size === 1) {
    return true;
  }
  return false;
}

function parseRotationTimestamp(raw: string | undefined): Date | null {
  if (!raw || raw.trim().length === 0) {
    return null;
  }
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    const ms = trimmed.length <= 10 ? num * 1000 : num;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

function resolveSourceClass(
  desc: ManagedSecretDescriptor,
  env: NodeJS.ProcessEnv
): { configured: boolean; sourceClass: SecretSourceClass; rawValue: string | undefined } {
  if (desc.key === "JWT_SECRET" && env.JWT_KEYS && env.JWT_KEYS.trim().length > 0) {
    return { configured: true, sourceClass: "keyring", rawValue: env.JWT_KEYS };
  }
  if (desc.fileKey && env[desc.fileKey] && env[desc.fileKey]!.trim().length > 0) {
    return { configured: true, sourceClass: "file_mount", rawValue: env[desc.key] };
  }
  const val = env[desc.key];
  if (val !== undefined && val.trim().length > 0) {
    return { configured: true, sourceClass: "env_var", rawValue: val };
  }
  return { configured: false, sourceClass: "unset", rawValue: undefined };
}

/**
 * Evaluates secret age, source class, and placeholder posture from environment metadata.
 * Never copies or returns secret values.
 */
export function evaluateSecretsRotation(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
  descriptors: readonly ManagedSecretDescriptor[] = DEFAULT_MANAGED_SECRETS
): SecretPolicyReport {
  const nodeEnv = (env.NODE_ENV ?? "development").trim() || "development";
  const placeholderKeys: string[] = [];
  let staleCount = 0;
  let warningCount = 0;
  let missingRequiredCount = 0;

  const secrets: SecretStatusMetadata[] = descriptors.map((desc) => {
    const { configured, sourceClass, rawValue } = resolveSourceClass(desc, env);

    if (rawValue !== undefined && isPlaceholderSecretValue(rawValue)) {
      placeholderKeys.push(desc.key);
    }

    if (!configured) {
      if (desc.required) {
        missingRequiredCount += 1;
      }
      return {
        key: desc.key,
        required: desc.required,
        configured: false,
        sourceClass: "unset",
        state: "missing",
        rotatedAt: null,
        ageDays: null,
        warnAfterDays: desc.warnAfterDays,
        maxAgeDays: desc.maxAgeDays,
      };
    }

    const rotatedKey = desc.rotatedAtKey ?? `${desc.key}_ROTATED_AT`;
    const rotatedDate =
      parseRotationTimestamp(env[rotatedKey]) ??
      parseRotationTimestamp(env.SECRETS_ROTATED_AT);

    if (!rotatedDate) {
      warningCount += 1;
      return {
        key: desc.key,
        required: desc.required,
        configured: true,
        sourceClass,
        state: "warning",
        rotatedAt: null,
        ageDays: null,
        warnAfterDays: desc.warnAfterDays,
        maxAgeDays: desc.maxAgeDays,
      };
    }

    const ageMs = Math.max(0, now.getTime() - rotatedDate.getTime());
    const ageDays = Number((ageMs / (1000 * 60 * 60 * 24)).toFixed(2));

    let state: SecretRotationState = "fresh";
    if (ageDays >= desc.maxAgeDays) {
      state = "stale";
      staleCount += 1;
    } else if (ageDays >= desc.warnAfterDays) {
      state = "warning";
      warningCount += 1;
    }

    return {
      key: desc.key,
      required: desc.required,
      configured: true,
      sourceClass,
      state,
      rotatedAt: rotatedDate.toISOString(),
      ageDays,
      warnAfterDays: desc.warnAfterDays,
      maxAgeDays: desc.maxAgeDays,
    };
  });

  const healthy =
    placeholderKeys.length === 0 && staleCount === 0 && missingRequiredCount === 0;

  return {
    checkedAt: now.toISOString(),
    nodeEnv,
    healthy,
    staleCount,
    warningCount,
    missingRequiredCount,
    placeholderKeys,
    secrets,
  };
}

export interface SecretPolicyStartupOptions {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  descriptors?: readonly ManagedSecretDescriptor[];
  logger?: Pick<AppLogger, "info" | "warn" | "error">;
  /** Defaults to true outside "test" environment unless STRICT_SECRET_VALIDATION=false. */
  rejectPlaceholders?: boolean;
}

/**
 * Enforces placeholder credential rejection at startup and emits redacted rotation warnings.
 */
export function enforceStartupSecretsPolicy(
  options: SecretPolicyStartupOptions = {}
): SecretPolicyReport {
  const env = options.env ?? process.env;
  const report = evaluateSecretsRotation(env, options.now, options.descriptors);
  const strictEnv = env.STRICT_SECRET_VALIDATION;
  const rejectPlaceholders =
    options.rejectPlaceholders ??
    (strictEnv === "true"
      ? true
      : strictEnv === "false"
        ? false
        : report.nodeEnv !== "test");

  if (rejectPlaceholders && report.placeholderKeys.length > 0) {
    options.logger?.error("Startup blocked due to placeholder secret configuration", {
      violatingKeys: report.placeholderKeys,
      nodeEnv: report.nodeEnv,
    });
    throw new SecretPolicyError(
      `Placeholder credentials detected for keys: ${report.placeholderKeys.join(", ")}`,
      report.placeholderKeys
    );
  }

  for (const item of report.secrets) {
    if (item.state === "stale") {
      options.logger?.warn("Managed secret has exceeded maximum rotation age", {
        secretKey: item.key,
        sourceClass: item.sourceClass,
        ageDays: item.ageDays,
        maxAgeDays: item.maxAgeDays,
      });
    } else if (item.state === "warning") {
      options.logger?.warn("Managed secret rotation warning", {
        secretKey: item.key,
        sourceClass: item.sourceClass,
        ageDays: item.ageDays,
        warnAfterDays: item.warnAfterDays,
        reason: item.rotatedAt === null ? "rotation_timestamp_missing" : "approaching_max_age",
      });
    }
  }

  return report;
}

export interface ScheduledRotationMonitorHandle {
  stop: () => void;
  runOnce: () => SecretPolicyReport;
}

/**
 * Starts a periodic background check emitting structured warnings for stale or aging secrets.
 */
export function startSecretRotationMonitor(
  options: SecretPolicyStartupOptions & { intervalMs?: number } = {}
): ScheduledRotationMonitorHandle {
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  const runOnce = (): SecretPolicyReport =>
    enforceStartupSecretsPolicy({
      ...options,
      rejectPlaceholders: false,
    });

  const timer = setInterval(() => {
    runOnce();
  }, intervalMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    runOnce,
  };
}
