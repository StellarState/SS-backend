import { randomUUID } from "crypto";
import { InvoiceStatus, NotificationType } from "../types/enums";
import { getCorrelationId } from "../observability/request-context";
import { recordReliabilityMetric } from "../observability/reliability-metrics";
import { logger } from "../observability/logger";
import { PublicAppError } from "./http-error";

/** Varchar-backed enums that PostgreSQL/TypeORM cannot infer from their type. */
export const VARCHAR_ENUMS: Record<string, Record<string, readonly string[]>> = {
  notifications: { type: Object.values(NotificationType) },
  contract_acls: { status: ["active", "removed"] },
  contract_acl_logs: { action: ["add", "remove"] },
  curve_migrations: { status: ["pending", "executed", "expired"] },
  key_merge_proposals: {
    status: ["pending", "approved", "rejected", "executed", "completed", "expired"],
  },
  pending_stellar_transactions: { status: ["PENDING_CONFIRMATION", "COMPLETED", "FAILED"] },
  settlement_intents: { status: ["prepared", "submitting", "distributed", "completed"] },
  investor_accreditations: { status: ["active", "pending_review", "rejected"] },
  invoice_fraud_reports: { status: ["open", "investigating", "resolved", "dismissed"] },
  user_audit_logs: { action: ["role_updated", "suspended", "unsuspended"] },
  invoice_status_history: {
    fromStatus: Object.values(InvoiceStatus),
    toStatus: Object.values(InvoiceStatus),
    actorRole: ["seller", "admin", "system"],
  },
  issuer_reputations: { tier: ["poor", "fair", "good", "excellent"] },
  issuer_reputation_history: {
    oldTier: ["poor", "fair", "good", "excellent"],
    newTier: ["poor", "fair", "good", "excellent"],
  },
  investor_risk_profiles: {
    tier: ["conservative", "moderate", "aggressive"],
    investmentExperience: ["none", "limited", "experienced"],
    timeHorizon: ["short", "medium", "long"],
    riskTolerance: ["low", "medium", "high"],
  },
  dividend_cycle_configs: { frequency: ["weekly", "monthly", "quarterly"] },
  dividend_distributions: {
    trigger: ["scheduled", "manual"],
    status: ["success", "failed", "pending"],
  },
};

export function isEnumValue(value: unknown, allowed: readonly (string | number)[]): boolean {
  return allowed.includes(value as string | number);
}

export function requireEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): T {
  if (isEnumValue(value, allowed)) return value as T;
  const correlationId = getCorrelationId() ?? randomUUID();
  recordReliabilityMetric("enum_rejected_writes");
  logger.warn("enum.write.rejected", { field, correlationId });
  throw new PublicAppError(400, `Invalid enum value for ${field}`, "INVALID_ENUM_VALUE", {
    field,
    correlationId,
  });
}
