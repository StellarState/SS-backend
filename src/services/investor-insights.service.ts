import { DataSource } from "typeorm";
import { AlertPreference } from "../models/AlertPreference.model";
import { OnboardingBonus } from "../models/OnboardingBonus.model";
import { YieldAdjustment } from "../models/YieldAdjustment.model";
import { Investment } from "../models/Investment.model";
import type { AppLogger } from "../observability/logger";
import { logger as globalLogger } from "../observability/logger";
import type { DecodedSorobanEvent } from "../types/soroban.types";
import { HttpError, PublicAppError } from "../utils/http-error";
import { InvalidLedgerTimeError, parseLedgerTime, processingLagMs } from "../lib/ledger-time";
import { Address, SorobanRpc, nativeToScVal, scValToNative, xdr } from "stellar-sdk";
import {
  ALERT_EVENTS,
  ALERT_VARIABLE_CONTRACT,
  DEFAULT_ALERT_CHANNELS,
  isSupportedPair,
  previewNotification,
  renderNotification,
  validateAlertPreferenceUpdate,
  validatePreviewRequest,
  type AlertEvent,
  type NotificationChannel,
  type NotificationPreview,
  type RenderedNotification,
} from "../lib/notification-templates";

const ONBOARDING_CACHE_TTL_MS = 60_000;
const YIELD_CACHE_TTL_MS = 5 * 60_000;

type AlertKind = AlertEvent;

/** Boolean column backing each event's on/off switch. */
const ENABLED_COLUMN: Record<
  AlertEvent,
  "settlementEnabled" | "kycExpiryEnabled" | "watchlistChangeEnabled" | "autoInvestEnabled" | "maturityEnabled"
> = {
  settlement: "settlementEnabled",
  kyc_expiry: "kycExpiryEnabled",
  watchlist_change: "watchlistChangeEnabled",
  auto_invest: "autoInvestEnabled",
  maturity: "maturityEnabled",
};

/**
 * Event-data aliases for each contract variable, in priority order. Keys
 * must match ALERT_VARIABLE_CONTRACT; the contract tests enforce this.
 */
export const ALERT_VARIABLE_ALIASES: Record<AlertEvent, Record<string, string[]>> = {
  settlement: {
    invoice_id: ["invoice_id", "invoice"],
    amount: ["amount", "settled_amount", "payment_amount", "payout"],
  },
  kyc_expiry: {
    wallet: [],
    expires_at: ["expires_at", "expiry", "expiry_date", "expiration"],
  },
  watchlist_change: {
    invoice_id: ["invoice_id", "invoice"],
    change: ["change", "change_type", "status", "reason"],
  },
  auto_invest: {
    invoice_id: ["invoice_id", "invoice"],
    amount: ["amount", "invested_amount", "investment_amount"],
  },
  maturity: {
    invoice_id: ["invoice_id", "invoice"],
  },
};

export interface OnboardingBonusStatus {
  is_claimed: boolean;
  bonus_amount: string | null;
  invoice_id: string | null;
  claimed_at: string | null;
}

export interface AlertPreferencesView {
  settlement: boolean;
  kyc_expiry: boolean;
  watchlist_change: boolean;
  auto_invest: boolean;
  maturity: boolean;
  /** Delivery channels per event; always a registered, non-empty set. */
  channels: Record<AlertEvent, NotificationChannel[]>;
}

/**
 * Resolve the stored channel map to a complete one. Events without a stored
 * choice get the defaults, and any pair no longer in the registry is dropped
 * so delivery never attempts an unsupported combination.
 */
function resolveChannels(
  stored: Partial<Record<AlertEvent, NotificationChannel[]>> | null | undefined
): Record<AlertEvent, NotificationChannel[]> {
  const resolved = {} as Record<AlertEvent, NotificationChannel[]>;
  for (const event of ALERT_EVENTS) {
    const chosen = (stored?.[event] ?? []).filter((channel) => isSupportedPair(event, channel));
    resolved[event] = chosen.length > 0 ? chosen : [...DEFAULT_ALERT_CHANNELS];
  }
  return resolved;
}

export interface YieldAdjustmentView {
  invoice_id: string;
  adjustment_bps: number;
  basis_rating: string | null;
  adjusted_yield: string | null;
  /** Ledger close time of the settlement event; the time history is ordered by. */
  settled_at: string | null;
  /** When the settlement was first projected; null for legacy rows. */
  processed_at: string | null;
  /** processed_at - settled_at in milliseconds; null when either is unknown. */
  processing_lag_ms: number | null;
}

interface CachedValue<T> {
  expiresAt: number;
  value: T;
}

interface InvestorInsightsConfig {
  notificationServiceUrl?: string;
  bonusPoolContractId?: string;
  bonusPoolStorageKey?: string;
  rpcUrl?: string;
  notificationServiceToken?: string;
}

function dataObject(value: unknown): Record<string, unknown> {
  if (value instanceof Map) {
    return Object.fromEntries(value.entries());
  }
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map((entry, index) => [String(index), entry]));
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Address) return value.toString();
  return null;
}

function valueFrom(
  data: Record<string, unknown>,
  aliases: string[],
  topics: unknown[],
  topicIndex: number,
): unknown {
  for (const alias of aliases) {
    if (data[alias] !== undefined && data[alias] !== null) return data[alias];
    const camel = alias.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    if (data[camel] !== undefined && data[camel] !== null) return data[camel];
  }
  if (data[String(topicIndex - 1)] !== undefined) return data[String(topicIndex - 1)];
  return topics[topicIndex];
}

function normalizeTopic(topic: string): string {
  return topic.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function preferenceFor(kind: AlertKind): AlertEvent {
  return kind;
}

function detectAlertKind(topic: string): AlertKind | null {
  const normalized = normalizeTopic(topic).replace(/_/g, "");
  if (
    normalized.includes("settlement") ||
    normalized.includes("settled") ||
    normalized.startsWith("settle") ||
    normalized.includes("paymentrecorded")
  ) return "settlement";
  if (
    normalized.includes("kycexpiry") ||
    normalized.includes("kycexpired") ||
    normalized.includes("kycexpiration")
  ) return "kyc_expiry";
  if (
    normalized.includes("watchlistchange") ||
    normalized.includes("watchlistupdated")
  ) return "watchlist_change";
  if (normalized.includes("autoinvest")) return "auto_invest";
  if (normalized.includes("maturity") || normalized.includes("matured")) return "maturity";
  return null;
}

/**
 * Extract the delivery variable contract for an event from its data. Only
 * named fields are read (no positional fallbacks), so a variable is either
 * genuinely present or left for the contract fallback.
 */
export function alertVariablesFromEvent(
  kind: AlertKind,
  data: Record<string, unknown>,
  wallet: string,
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const name of Object.keys(ALERT_VARIABLE_CONTRACT[kind])) {
    if (name === "wallet") {
      variables.wallet = wallet;
      continue;
    }
    for (const alias of ALERT_VARIABLE_ALIASES[kind][name] ?? []) {
      const camel = alias.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      const value = scalarString(data[alias] ?? data[camel]);
      if (value !== null && value.trim() !== "") {
        variables[name] = value;
        break;
      }
    }
  }
  return variables;
}

export class InvestorInsightsService {
  private readonly onboardingCache = new Map<string, CachedValue<OnboardingBonusStatus>>();
  private readonly preferenceCache = new Map<string, CachedValue<AlertPreferencesView>>();
  private readonly currentYieldCache = new Map<string, CachedValue<YieldAdjustmentView>>();
  private readonly yieldHistoryCache = new Map<string, CachedValue<YieldAdjustmentView[]>>();
  private readonly logger: AppLogger;
  private readonly rpcServer?: SorobanRpc.Server;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: InvestorInsightsConfig = {},
    logger: AppLogger = globalLogger,
    private readonly request: typeof fetch = fetch,
  ) {
    this.logger = logger;
    if (config.rpcUrl) {
      this.rpcServer = new SorobanRpc.Server(config.rpcUrl, {
        allowHttp: config.rpcUrl.startsWith("http://"),
      });
    }
  }

  async getOnboardingBonus(wallet: string): Promise<OnboardingBonusStatus> {
    const cached = this.readCache(this.onboardingCache, wallet);
    if (cached) return cached;

    const bonus = await this.dataSource.getRepository(OnboardingBonus).findOne({ where: { wallet } });
    const status: OnboardingBonusStatus = bonus
      ? {
          is_claimed: true,
          bonus_amount: bonus.bonusAmount,
          invoice_id: bonus.invoiceId,
          claimed_at: bonus.claimedAt.toISOString(),
        }
      : { is_claimed: false, bonus_amount: null, invoice_id: null, claimed_at: null };
    this.writeCache(this.onboardingCache, wallet, status, ONBOARDING_CACHE_TTL_MS);
    return status;
  }

  async getAlertPreferences(wallet: string): Promise<AlertPreferencesView> {
    const cached = this.readCache(this.preferenceCache, wallet);
    if (cached) return cached;

    const preferences = await this.dataSource.getRepository(AlertPreference).findOne({ where: { wallet } });
    const view: AlertPreferencesView = preferences
      ? {
          settlement: preferences.settlementEnabled,
          kyc_expiry: preferences.kycExpiryEnabled,
          watchlist_change: preferences.watchlistChangeEnabled,
          auto_invest: preferences.autoInvestEnabled,
          maturity: preferences.maturityEnabled,
          channels: resolveChannels(preferences.channels),
        }
      : {
          settlement: true,
          kyc_expiry: true,
          watchlist_change: true,
          auto_invest: true,
          maturity: true,
          channels: resolveChannels(null),
        };
    this.writeCache(this.preferenceCache, wallet, view, ONBOARDING_CACHE_TTL_MS);
    return view;
  }

  /**
   * Partially update a wallet's alert preferences (issue #811). Every
   * requested (event, channel) pair is checked against the template
   * registry first; any unsupported or malformed selection rejects the
   * whole request with per-field errors and nothing is written.
   */
  async updateAlertPreferences(wallet: string, input: unknown): Promise<AlertPreferencesView> {
    const result = validateAlertPreferenceUpdate(input);
    if (!result.ok) {
      throw new PublicAppError(422, "Invalid alert preferences.", "VALIDATION_ERROR", result.errors);
    }

    const repository = this.dataSource.getRepository(AlertPreference);
    const existing = await repository.findOne({ where: { wallet } });
    const channels: Partial<Record<AlertEvent, NotificationChannel[]>> = {
      ...(existing?.channels ?? {}),
    };
    const enabled: Partial<Record<(typeof ENABLED_COLUMN)[AlertEvent], boolean>> = {};
    for (const [event, change] of Object.entries(result.value) as Array<
      [AlertEvent, { enabled?: boolean; channels?: NotificationChannel[] }]
    >) {
      if (change.enabled !== undefined) enabled[ENABLED_COLUMN[event]] = change.enabled;
      if (change.channels !== undefined) channels[event] = change.channels;
    }

    // New rows spell out every switch rather than leaning on column
    // defaults, so the saved entity (and the cache built from it) is complete.
    const defaults = Object.fromEntries(
      Object.values(ENABLED_COLUMN).map((column) => [column, true])
    );
    await repository.save(
      repository.create({
        ...defaults,
        ...(existing ?? {}),
        wallet,
        ...enabled,
        channels,
      })
    );
    this.preferenceCache.delete(wallet);
    return this.getAlertPreferences(wallet);
  }

  /**
   * Render a preview for one (event, channel) pair. Pure: it uses only the
   * template registry and never touches the notification transport, so a
   * preview cannot be delivered.
   */
  previewAlert(input: unknown): NotificationPreview {
    const result = validatePreviewRequest(input);
    if (!result.ok) {
      throw new PublicAppError(422, "Invalid preview request.", "VALIDATION_ERROR", result.errors);
    }
    return previewNotification(result.value);
  }

  async getYieldAdjustment(invoiceId: string): Promise<YieldAdjustmentView> {
    const cached = this.readCache(this.currentYieldCache, invoiceId);
    if (cached) return cached;

    const row = await this.dataSource.getRepository(YieldAdjustment).findOne({
      where: { invoiceId },
      // Ledger time, then event id (Soroban paging tokens sort in ledger
      // order) so settlements in the same ledger second order deterministically.
      order: { settledAt: "DESC", settlementEventId: "DESC" },
    });
    const view = row
      ? this.toYieldView(row)
      : {
          invoice_id: invoiceId,
          adjustment_bps: 0,
          basis_rating: null,
          adjusted_yield: null,
          settled_at: null,
          processed_at: null,
          processing_lag_ms: null,
        };
    this.writeCache(this.currentYieldCache, invoiceId, view, YIELD_CACHE_TTL_MS);
    return view;
  }

  async getYieldAdjustmentHistory(invoiceId: string): Promise<YieldAdjustmentView[]> {
    const cached = this.readCache(this.yieldHistoryCache, invoiceId);
    if (cached) return cached;

    const rows = await this.dataSource.getRepository(YieldAdjustment).find({
      where: { invoiceId },
      // Ledger time, then event id (Soroban paging tokens sort in ledger
      // order) so settlements in the same ledger second order deterministically.
      order: { settledAt: "DESC", settlementEventId: "DESC" },
    });
    const history = rows.map((row) => this.toYieldView(row));
    this.writeCache(this.yieldHistoryCache, invoiceId, history, YIELD_CACHE_TTL_MS);
    return history;
  }

  async getBonusPoolBalance(): Promise<string> {
    if (!this.rpcServer || !this.config.bonusPoolContractId) {
      throw new HttpError(503, "Onboarding bonus pool contract is not configured.");
    }
    let contractAddress: xdr.ScAddress;
    try {
      contractAddress = new Address(this.config.bonusPoolContractId).toScAddress();
    } catch {
      const rawBytes = Buffer.from(this.config.bonusPoolContractId, "utf8");
      contractAddress = xdr.ScAddress.scAddressTypeContract(rawBytes.subarray(0, 32));
    }

    const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: contractAddress,
        key: nativeToScVal(this.config.bonusPoolStorageKey ?? "pool_balance", { type: "symbol" }),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const result = await this.rpcServer.getLedgerEntries(ledgerKey);
    const storedEntry = result.entries[0];
    if (!storedEntry) throw new HttpError(404, "Onboarding bonus pool balance was not found on-chain.");
    const entry = storedEntry.val.contractData().val();
    const balance = scValToNative(entry);
    const parsed = scalarString(balance);
    if (parsed === null) {
      throw new Error("The onboarding bonus pool storage value is not a scalar balance.");
    }
    return parsed;
  }

  async processEvent(event: DecodedSorobanEvent): Promise<void> {
    const topic = normalizeTopic(event.topic);
    const data = dataObject(event.data);
    const topics = event.topics;
    const eventId = event.id || `${event.txHash}:${topic}:${event.ledger}`;

    if (topic === "onboarding_bonus_claimed") {
      await this.processOnboardingBonus(event, data, topics, eventId);
      return;
    }

    if (topic === "alert_preference_updated") {
      await this.processAlertPreference(event, data, topics, eventId);
      return;
    }

    if (
      topic.includes("settle") ||
      topic.includes("settlement") ||
      topic.includes("invoice_settled") ||
      topic.includes("yield_adjustment") ||
      topic.includes("payment_recorded")
    ) {
      await this.processYieldAdjustment(event, data, topics, eventId);
    }

    const kind = detectAlertKind(event.topic);
    if (kind) await this.dispatchAlert(event, data, topics, kind);
  }

  private async processOnboardingBonus(
    event: DecodedSorobanEvent,
    data: Record<string, unknown>,
    topics: unknown[],
    eventId: string,
  ): Promise<void> {
    const wallet = scalarString(valueFrom(data, ["wallet", "investor", "investor_wallet", "claimer"], topics, 1));
    const amount = scalarString(valueFrom(data, ["bonus_amount", "amount"], topics, 2));
    const invoiceValue = valueFrom(data, ["invoice_id", "invoice"], topics, 3);
    if (!wallet || amount === null || !Number.isFinite(Number(amount)) || Number(amount) < 0) {
      throw new Error(`OnboardingBonusClaimed event ${eventId} is missing a valid wallet or bonus amount.`);
    }

    const claimedAtValue = scalarString(data.claimed_at ?? data.claimedAt) ?? event.ledgerClosedAt;
    const claimedAt = new Date(claimedAtValue);
    if (Number.isNaN(claimedAt.getTime())) {
      throw new Error(`OnboardingBonusClaimed event ${eventId} has an invalid claim timestamp.`);
    }
    const repository = this.dataSource.getRepository(OnboardingBonus);
    const existing = await repository.findOne({ where: [{ wallet }, { eventId }] });
    await repository.save(repository.create({
      ...(existing ?? {}),
      wallet,
      bonusAmount: amount,
      invoiceId: scalarString(invoiceValue),
      claimedAt,
      eventId,
    }));
    this.onboardingCache.delete(wallet);
  }

  private async processAlertPreference(
    event: DecodedSorobanEvent,
    data: Record<string, unknown>,
    topics: unknown[],
    eventId: string,
  ): Promise<void> {
    const wallet = scalarString(valueFrom(data, ["wallet", "investor", "owner"], topics, 1));
    if (!wallet) throw new Error(`AlertPreferenceUpdated event ${eventId} is missing its wallet.`);

    const rawPreferences = data.preferences ?? data;
    const values = dataObject(rawPreferences);
    if (Array.isArray(rawPreferences)) {
      const names = ["settlement", "kyc_expiry", "watchlist_change", "auto_invest", "maturity"];
      rawPreferences.forEach((value, index) => {
        if (names[index]) values[names[index]] = value;
      });
    }
    const repository = this.dataSource.getRepository(AlertPreference);
    const existing = await repository.findOne({ where: { wallet } });
    const preference = repository.create({
      ...(existing ?? {}),
      wallet,
      settlementEnabled: this.booleanPreference(values, ["settlement", "settlements", "settlement_enabled"], existing?.settlementEnabled),
      kycExpiryEnabled: this.booleanPreference(values, ["kyc_expiry", "kyc_expired", "kyc_expiry_enabled"], existing?.kycExpiryEnabled),
      watchlistChangeEnabled: this.booleanPreference(values, ["watchlist_change", "watchlist", "watchlist_change_enabled"], existing?.watchlistChangeEnabled),
      autoInvestEnabled: this.booleanPreference(values, ["auto_invest", "auto_invest_enabled"], existing?.autoInvestEnabled),
      maturityEnabled: this.booleanPreference(values, ["maturity", "maturity_enabled"], existing?.maturityEnabled),
      eventId,
    });
    await repository.save(preference);
    this.preferenceCache.delete(wallet);
  }

  private async processYieldAdjustment(
    event: DecodedSorobanEvent,
    data: Record<string, unknown>,
    topics: unknown[],
    eventId: string,
  ): Promise<void> {
    const invoiceId = scalarString(valueFrom(data, ["invoice_id", "invoice"], topics, 1));
    if (!invoiceId) return;

    const adjustmentValue = valueFrom(data, ["adjustment_bps", "yield_adjustment_bps", "bps"], topics, 2);
    const basisRatingValue = valueFrom(data, ["basis_rating", "rating"], topics, 3);
    const adjustedYieldValue = valueFrom(data, ["adjusted_yield", "yield_after_adjustment"], topics, 4);
    const adjustmentBps = adjustmentValue === undefined ? 0 : Number(adjustmentValue);
    if (!Number.isInteger(adjustmentBps)) {
      throw new Error(`Settlement event ${eventId} has invalid adjustment basis points.`);
    }
    // The indexer quarantines events with invalid ledger times before they
    // get here; this guards direct callers. Never fall back to processing time.
    const ledgerTime = parseLedgerTime(event.ledgerClosedAt);
    if (!ledgerTime.ok) throw new InvalidLedgerTimeError(eventId, ledgerTime.reason);
    const repository = this.dataSource.getRepository(YieldAdjustment);
    const existing = await repository.findOne({ where: { settlementEventId: eventId } });
    await repository.save(repository.create({
      ...(existing ?? {}),
      invoiceId,
      settlementEventId: eventId,
      adjustmentBps,
      basisRating: scalarString(basisRatingValue),
      adjustedYield: scalarString(adjustedYieldValue),
      // Issue #812: authoritative timestamps survive replays. settledAt is the
      // ledger time recorded first; processedAt is the first projection time.
      settledAt: existing?.settledAt ?? ledgerTime.value,
      processedAt: existing?.processedAt ?? new Date(),
      transactionHash: event.txHash,
    }));
    this.currentYieldCache.delete(invoiceId);
    this.yieldHistoryCache.delete(invoiceId);
  }

  private async dispatchAlert(
    event: DecodedSorobanEvent,
    data: Record<string, unknown>,
    topics: unknown[],
    kind: AlertKind,
  ): Promise<void> {
    const primaryWallet = scalarString(valueFrom(
      data,
      ["wallet", "investor", "investor_wallet", "owner", "user"],
      kind === "settlement" ? [] : topics,
      1,
    ));
    const listedWallets = Array.isArray(data.wallets)
      ? data.wallets.map(scalarString).filter((wallet): wallet is string => wallet !== null)
      : [];
    let wallets = primaryWallet ? [primaryWallet, ...listedWallets] : listedWallets;
    if (kind === "settlement") {
      const invoiceId = scalarString(valueFrom(data, ["invoice_id", "invoice"], topics, 1));
      if (invoiceId) {
        const investments = await this.dataSource.getRepository(Investment).find({
          where: { invoiceId },
          relations: { investor: true },
        });
        wallets = [...wallets, ...investments
          .map((investment) => investment.investor?.stellarAddress)
          .filter((wallet): wallet is string => Boolean(wallet))];
      }
    }
    if (wallets.length === 0) return;
    const notificationServiceUrl = this.config.notificationServiceUrl;
    if (!notificationServiceUrl) {
      throw new Error("NOTIFICATION_SERVICE_URL is required to dispatch opted-in investor alerts.");
    }

    await Promise.all([...new Set(wallets)].map(async (wallet) => {
      const preferences = await this.getAlertPreferences(wallet);
      if (!preferences[preferenceFor(kind)]) return;
      const rendered = this.renderForDelivery(kind, preferences.channels[kind], data, wallet, event.id);
      if (rendered.length === 0) return;
      try {
        const response = await this.request(notificationServiceUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `${event.id}:${wallet}`,
            ...(this.config.notificationServiceToken
              ? { authorization: `Bearer ${this.config.notificationServiceToken}` }
              : {}),
          },
          body: JSON.stringify({
            wallet,
            event_type: kind,
            event: {
              id: event.id,
              topic: event.topic,
              transaction_hash: event.txHash,
              ledger: event.ledger,
              data: event.data,
            },
            channels: rendered.map((message) => message.channel),
            rendered,
          }),
          signal: AbortSignal.timeout(4_500),
        });
        if (!response.ok) {
          throw new Error(`Notification service returned HTTP ${response.status} for ${event.id}.`);
        }
      } catch (error) {
        this.logger.error("Investor alert dispatch failed", {
          eventId: event.id,
          eventType: kind,
          error,
        });
        throw error;
      }
    }));
  }

  /**
   * Build the contract variables for one recipient and render each chosen
   * channel through the shared registry renderer, the same one preview uses.
   * A channel that cannot render (a required variable is absent from the
   * event) is logged and skipped so the other channels still deliver.
   */
  private renderForDelivery(
    kind: AlertKind,
    channels: NotificationChannel[],
    data: Record<string, unknown>,
    wallet: string,
    eventId: string,
  ): RenderedNotification[] {
    const variables = alertVariablesFromEvent(kind, data, wallet);
    const rendered: RenderedNotification[] = [];
    for (const channel of channels) {
      try {
        rendered.push(renderNotification(kind, channel, variables));
      } catch (error) {
        this.logger.error("Investor alert render failed", {
          eventId,
          eventType: kind,
          channel,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return rendered;
  }

  private booleanPreference(
    source: Record<string, unknown>,
    keys: string[],
    fallback: boolean | undefined,
  ): boolean {
    for (const key of keys) {
      if (typeof source[key] === "boolean") return source[key] as boolean;
      if (source[key] === 0 || source[key] === 1) return Boolean(source[key]);
    }
    return fallback ?? true;
  }

  private toYieldView(row: YieldAdjustment): YieldAdjustmentView {
    return {
      invoice_id: row.invoiceId,
      adjustment_bps: row.adjustmentBps,
      basis_rating: row.basisRating,
      adjusted_yield: row.adjustedYield,
      settled_at: new Date(row.settledAt).toISOString(),
      processed_at: row.processedAt ? new Date(row.processedAt).toISOString() : null,
      processing_lag_ms: processingLagMs(row.settledAt, row.processedAt),
    };
  }

  private readCache<T>(cache: Map<string, CachedValue<T>>, key: string): T | undefined {
    const cached = cache.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
      cache.delete(key);
      return undefined;
    }
    return cached.value;
  }

  private writeCache<T>(
    cache: Map<string, CachedValue<T>>,
    key: string,
    value: T,
    ttl: number,
  ): void {
    cache.set(key, { value, expiresAt: Date.now() + ttl });
  }
}

export function createInvestorInsightsService(
  dataSource: DataSource,
  config?: InvestorInsightsConfig,
  logger?: AppLogger,
): InvestorInsightsService {
  return new InvestorInsightsService(dataSource, config, logger);
}
