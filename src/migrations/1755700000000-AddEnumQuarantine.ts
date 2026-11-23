import type { MigrationInterface, QueryRunner } from "typeorm";

const CONSTRAINTS: Array<[string, string, string[]]> = [
  [
    "notifications",
    "type",
    [
      "invoice",
      "investment",
      "payment",
      "kyc",
      "system",
      "invoice_rejected",
      "kyc_approved",
      "kyc_rejected",
      "investment_confirmed",
      "invoice_funded",
      "invoice_settled",
      "investment_created",
      "invoice_approved",
      "invoice_deadline_extended",
      "invoice_matured",
      "settlement_received",
      "refund_processed",
      "secondary_market_sold",
      "kyc_status_change",
      "subscription",
      "subscription_expiring",
    ],
  ],
  ["contract_acls", "status", ["active", "removed"]],
  ["contract_acl_logs", "action", ["add", "remove"]],
  ["curve_migrations", "status", ["pending", "executed", "expired"]],
  [
    "key_merge_proposals",
    "status",
    ["pending", "approved", "rejected", "executed", "completed", "expired"],
  ],
  ["pending_stellar_transactions", "status", ["PENDING_CONFIRMATION", "COMPLETED", "FAILED"]],
  ["settlement_intents", "status", ["prepared", "submitting", "distributed", "completed"]],
  ["investor_accreditations", "status", ["active", "pending_review", "rejected"]],
  ["invoice_fraud_reports", "status", ["open", "investigating", "resolved", "dismissed"]],
  ["user_audit_logs", "action", ["role_updated", "suspended", "unsuspended"]],
  [
    "invoice_status_history",
    "from_status",
    ["draft", "pending", "published", "funded", "settled", "cancelled", "rejected", "failed"],
  ],
  [
    "invoice_status_history",
    "to_status",
    ["draft", "pending", "published", "funded", "settled", "cancelled", "rejected", "failed"],
  ],
  ["invoice_status_history", "actor_role", ["seller", "admin", "system"]],
  ["issuer_reputations", "tier", ["poor", "fair", "good", "excellent"]],
  ["issuer_reputation_history", "old_tier", ["poor", "fair", "good", "excellent"]],
  ["issuer_reputation_history", "new_tier", ["poor", "fair", "good", "excellent"]],
  ["investor_risk_profiles", "tier", ["conservative", "moderate", "aggressive"]],
  ["investor_risk_profiles", "investment_experience", ["none", "limited", "experienced"]],
  ["investor_risk_profiles", "time_horizon", ["short", "medium", "long"]],
  ["investor_risk_profiles", "risk_tolerance", ["low", "medium", "high"]],
  ["dividend_cycle_configs", "frequency", ["weekly", "monthly", "quarterly"]],
  ["dividend_distributions", "trigger", ["scheduled", "manual"]],
  ["dividend_distributions", "status", ["success", "failed", "pending"]],
];

export class AddEnumQuarantine1755700000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE IF NOT EXISTS enum_quarantine (
      id varchar(64) PRIMARY KEY, source_table varchar(128) NOT NULL,
      source_column varchar(128) NOT NULL, record_id varchar(512) NOT NULL,
      raw_value varchar(256) NOT NULL, correlation_id varchar(128) NOT NULL,
      observed_at timestamptz NOT NULL)`);
    await runner.query(
      `CREATE INDEX IF NOT EXISTS idx_enum_quarantine_observed ON enum_quarantine (observed_at, id)`
    );
    for (const [table, column, values] of CONSTRAINTS) {
      const exists = await runner.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
        [table, column]
      );
      if (!exists.length) continue;
      const name = `enum_guard_${table}_${column}`;
      const literals = values.map((value) => "'" + value.replace(/'/g, "''") + "'").join(",");
      await runner.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK ("${column}" IN (${literals})) NOT VALID`
      );
    }
  }
  async down(runner: QueryRunner): Promise<void> {
    for (const [table, column] of CONSTRAINTS) {
      if (await runner.hasTable(table)) {
        await runner.query(
          `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "enum_guard_${table}_${column}"`
        );
      }
    }
    // Preserve operator evidence through rollback. Reapplication is idempotent.
  }
}
