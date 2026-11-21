import crypto from "crypto";
import { DataSource } from "typeorm";
import { WebhookSubscription } from "../models/WebhookSubscription.model";
import { WebhookDeliveryLog } from "../models/WebhookDeliveryLog.model";
import { logger, type AppLogger } from "../observability/logger";
import { withCorrelationHeaders } from "../observability/request-context";
import { validateWebhookUrl, UrlValidationError } from "../utils/url-validation";

export function generateWebhookSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export type WebhookDeliveryOutcome = "succeeded" | "failed" | "deferred";

export interface WebhookDispatchResult {
  subscriptionId: string;
  outcome: WebhookDeliveryOutcome;
  delivered: boolean;
  attempts: number;
  responseStatus: number | null;
  /**
   * `true` when the event was already delivered for this subscription and was
   * therefore skipped. A duplicate response lets callers/logs identify the
   * event as already handled instead of re-triggering downstream side effects.
   */
  duplicate?: boolean;
  /** Error message when delivery or validation failed. */
  error?: string | null;
  /** Reason when outcome is `"deferred"` (for example `"shutdown"`). */
  deferredReason?: string;
}

export interface WebhookDispatcherOptions {
  /** Maximum concurrent active HTTP delivery requests (including retries). Default: 10. */
  maxConcurrency?: number;
  /** Number of active subscriptions fetched per database page. Default: 50. */
  pageSize?: number;
  /** Maximum delivery attempts per subscription. Default: 3. */
  maxAttempts?: number;
  /** Base backoff delay in ms for retries (`retryBaseDelayMs * 2 ** (attempt - 1)`). Default: 100. */
  retryBaseDelayMs?: number;
  /** Per-request HTTP timeout in ms. Default: 5000. */
  requestTimeoutMs?: number;
}

export interface WebhookDispatchOptions {
  /** Optional abort signal to trigger graceful shutdown of this dispatch call. */
  signal?: AbortSignal;
  /** Subscription IDs to skip (for example already settled before a shutdown). */
  excludeSubscriptionIds?: Iterable<string>;
  /** Page offset to start fetching active subscriptions from. Default: 0. */
  startOffset?: number;
}

export interface PendingWebhookDispatch {
  eventType: string;
  payload: unknown;
  eventId?: string;
  /** Subscriptions from the interrupted page that were deferred due to shutdown. */
  deferredSubscriptionIds: string[];
  /** Subscriptions from the interrupted page that already settled before shutdown. */
  settledSubscriptionIds: string[];
  /** Offset from which to resume paging active subscriptions. */
  resumeOffset: number;
  /** Whether additional database pages may remain beyond the interrupted page. */
  hasMorePages: boolean;
}

const DEFAULT_MAX_CONCURRENCY = 10;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

interface ConcurrencyWaiter {
  resolve: (acquired: boolean) => void;
  cleanup?: () => void;
}

class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: ConcurrencyWaiter[] = [];

  constructor(private readonly maxConcurrency: number) {}

  getActiveCount(): number {
    return this.active;
  }

  acquire(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) {
      return Promise.resolve(false);
    }
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      const waiter: ConcurrencyWaiter = { resolve };
      if (signal) {
        const onAbort = () => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) {
            this.waiters.splice(idx, 1);
          }
          resolve(false);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.waiters.push(waiter);
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.active < this.maxConcurrency && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next.cleanup?.();
      this.active += 1;
      next.resolve(true);
    }
  }
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  if (ms <= 0) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createCombinedSignal(
  primary: AbortSignal,
  secondary?: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  if (!secondary) {
    return { signal: primary, cleanup: () => undefined };
  }
  const controller = new AbortController();
  if (primary.aborted || secondary.aborted) {
    controller.abort();
    return { signal: controller.signal, cleanup: () => undefined };
  }
  const onAbort = () => controller.abort();
  primary.addEventListener("abort", onAbort, { once: true });
  secondary.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      primary.removeEventListener("abort", onAbort);
      secondary.removeEventListener("abort", onAbort);
    },
  };
}

export class WebhookDispatcherService {
  private readonly maxConcurrency: number;
  private readonly pageSize: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly concurrencyLimiter: ConcurrencyLimiter;
  private shutdownController = new AbortController();
  private readonly pendingDispatches: PendingWebhookDispatch[] = [];

  constructor(
    private readonly dataSource: DataSource,
    private readonly appLogger: AppLogger = logger,
    options: WebhookDispatcherOptions = {}
  ) {
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY));
    this.pageSize = Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE));
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.concurrencyLimiter = new ConcurrencyLimiter(this.maxConcurrency);
  }

  /**
   * Signals graceful shutdown. Active in-flight HTTP attempts complete cleanly,
   * while queued subscriptions, pending retries, and unfetched pages are
   * deferred and recorded in `getPendingDispatches()` so work can be inspected
   * and safely resumed.
   */
  shutdown(): void {
    if (!this.shutdownController.signal.aborted) {
      this.shutdownController.abort();
    }
  }

  isShuttingDown(): boolean {
    return this.shutdownController.signal.aborted;
  }

  getActiveRequestCount(): number {
    return this.concurrencyLimiter.getActiveCount();
  }

  getPendingDispatches(): PendingWebhookDispatch[] {
    return this.pendingDispatches.map((entry) => ({
      ...entry,
      deferredSubscriptionIds: [...entry.deferredSubscriptionIds],
      settledSubscriptionIds: [...entry.settledSubscriptionIds],
    }));
  }

  clearPendingDispatches(): void {
    this.pendingDispatches.length = 0;
  }

  async resumePendingDispatch(
    pending: PendingWebhookDispatch,
    options: Omit<WebhookDispatchOptions, "startOffset" | "excludeSubscriptionIds"> = {}
  ): Promise<WebhookDispatchResult[]> {
    return this.dispatchWebhookEvent(pending.eventType, pending.payload, pending.eventId, {
      ...options,
      startOffset: pending.resumeOffset,
      excludeSubscriptionIds: pending.settledSubscriptionIds,
    });
  }

  async dispatchWebhookEvent(
    eventType: string,
    payload: unknown,
    eventId?: string,
    options: WebhookDispatchOptions = {}
  ): Promise<WebhookDispatchResult[]> {
    const body = JSON.stringify({ eventType, payload });
    const excluded = new Set<string>(options.excludeSubscriptionIds ?? []);
    const { signal, cleanup } = createCombinedSignal(this.shutdownController.signal, options.signal);

    const results: WebhookDispatchResult[] = [];
    let offset = Math.max(0, Math.floor(options.startOffset ?? 0));

    try {
      let hasMorePages = true;
      while (hasMorePages) {
        if (signal.aborted) {
          this.pendingDispatches.push({
            eventType,
            payload,
            eventId,
            deferredSubscriptionIds: [],
            settledSubscriptionIds: [],
            resumeOffset: offset,
            hasMorePages: true,
          });
          break;
        }

        const pageStartOffset = offset;
        const page = await this.dataSource.getRepository(WebhookSubscription).find({
          where: { active: true },
          order: { id: "ASC" },
          skip: pageStartOffset,
          take: this.pageSize,
        });

        offset += page.length;
        hasMorePages = page.length === this.pageSize;

        const eligible = page.filter(
          (subscription) =>
            Array.isArray(subscription.eventTypes) &&
            subscription.eventTypes.includes(eventType) &&
            !excluded.has(subscription.id)
        );

        const pageResults = await this.processPage(eligible, eventType, body, eventId, signal);
        results.push(...pageResults);

        const deferredIds = pageResults
          .filter((r) => r.outcome === "deferred")
          .map((r) => r.subscriptionId);

        if (signal.aborted && (deferredIds.length > 0 || hasMorePages)) {
          const settledIds = pageResults
            .filter((r) => r.outcome !== "deferred")
            .map((r) => r.subscriptionId);

          this.pendingDispatches.push({
            eventType,
            payload,
            eventId,
            deferredSubscriptionIds: deferredIds,
            settledSubscriptionIds: deferredIds.length > 0 ? settledIds : [],
            resumeOffset: deferredIds.length > 0 ? pageStartOffset : offset,
            hasMorePages,
          });
          break;
        }

        if (!hasMorePages) {
          break;
        }
      }
    } finally {
      cleanup();
    }

    return results;
  }

  private async processPage(
    subscriptions: WebhookSubscription[],
    eventType: string,
    body: string,
    eventId: string | undefined,
    signal: AbortSignal
  ): Promise<WebhookDispatchResult[]> {
    if (subscriptions.length === 0) {
      return [];
    }

    const pageResults = new Array<WebhookDispatchResult>(subscriptions.length);
    let nextIndex = 0;
    const workerCount = Math.min(this.maxConcurrency, subscriptions.length);

    const runWorker = async (): Promise<void> => {
      while (nextIndex < subscriptions.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        const subscription = subscriptions[currentIndex];
        if (signal.aborted) {
          pageResults[currentIndex] = this.buildDeferredResult(subscription.id, 0, null);
          continue;
        }

        pageResults[currentIndex] = await this.deliver(
          subscription,
          eventType,
          body,
          eventId,
          signal
        );
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return pageResults;
  }

  private buildDeferredResult(
    subscriptionId: string,
    attempts: number,
    responseStatus: number | null
  ): WebhookDispatchResult {
    return {
      subscriptionId,
      outcome: "deferred",
      delivered: false,
      attempts,
      responseStatus,
      duplicate: false,
      deferredReason: "shutdown",
    };
  }

  private async deliver(
    subscription: WebhookSubscription,
    eventType: string,
    body: string,
    eventId: string | undefined,
    signal: AbortSignal
  ): Promise<WebhookDispatchResult> {
    let attemptsMade = 0;
    let lastStatus: number | null = null;
    let lastError: string | null = null;

    try {
      if (signal.aborted) {
        return this.buildDeferredResult(subscription.id, 0, null);
      }

      if (eventId && (await this.alreadyDelivered(subscription.id, eventId))) {
        this.appLogger.info("webhook.event.already_handled", {
          subscription_id: subscription.id,
          event_type: eventType,
          event_id: eventId,
        });
        return {
          subscriptionId: subscription.id,
          outcome: "succeeded",
          delivered: false,
          attempts: 0,
          responseStatus: null,
          duplicate: true,
        };
      }

      try {
        validateWebhookUrl(subscription.url);
      } catch (error) {
        const errorMsg =
          error instanceof UrlValidationError ? error.message : "URL validation failed";
        this.appLogger.warn("webhook.url.validation_failed", {
          subscription_id: subscription.id,
          url: subscription.url,
          error: errorMsg,
        });
        await this.logDelivery(subscription.id, eventType, eventId, 0, null, false, errorMsg);
        return {
          subscriptionId: subscription.id,
          outcome: "failed",
          delivered: false,
          attempts: 0,
          responseStatus: null,
          duplicate: false,
          error: errorMsg,
        };
      }

      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        if (signal.aborted) {
          return this.buildDeferredResult(subscription.id, attemptsMade, lastStatus);
        }

        const acquired = await this.concurrencyLimiter.acquire(signal);
        if (!acquired) {
          return this.buildDeferredResult(subscription.id, attemptsMade, lastStatus);
        }

        attemptsMade = attempt;
        let delivered = false;
        let attemptStatus: number | null = null;
        let attemptError: string | null = null;

        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
          try {
            const response = await fetch(subscription.url, {
              method: "POST",
              headers: withCorrelationHeaders({
                "content-type": "application/json",
                "x-signature": generateWebhookSignature(body, subscription.secret),
                ...(eventId ? { "x-event-id": eventId } : {}),
              }),
              body,
              signal: controller.signal,
            });
            attemptStatus = response.status;
            lastStatus = response.status;
            delivered = response.status >= 200 && response.status < 300;
            attemptError = delivered ? null : `HTTP ${response.status}`;
            lastError = attemptError;
          } finally {
            clearTimeout(timer);
          }
        } catch (error) {
          attemptError = error instanceof Error ? error.message : "Webhook request failed";
          lastError = attemptError;
        } finally {
          this.concurrencyLimiter.release();
        }

        await this.logDelivery(
          subscription.id,
          eventType,
          eventId,
          attempt,
          attemptStatus ?? lastStatus,
          delivered,
          attemptError
        );

        if (delivered) {
          return {
            subscriptionId: subscription.id,
            outcome: "succeeded",
            delivered: true,
            attempts: attempt,
            responseStatus: attemptStatus,
            duplicate: false,
          };
        }

        if (attempt < this.maxAttempts) {
          const delayMs = this.retryBaseDelayMs * 2 ** (attempt - 1);
          const slept = await sleepWithSignal(delayMs, signal);
          if (!slept) {
            return this.buildDeferredResult(subscription.id, attemptsMade, lastStatus);
          }
        }
      }

      this.appLogger.warn("webhook.delivery.failed", {
        subscription_id: subscription.id,
        event_type: eventType,
        event_id: eventId ?? null,
        status: lastStatus,
        error: lastError,
      });
      return {
        subscriptionId: subscription.id,
        outcome: "failed",
        delivered: false,
        attempts: attemptsMade,
        responseStatus: lastStatus,
        duplicate: false,
        error: lastError,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Webhook delivery failed";
      this.appLogger.warn("webhook.delivery.unexpected_error", {
        subscription_id: subscription.id,
        event_type: eventType,
        event_id: eventId ?? null,
        error: errorMsg,
      });
      return {
        subscriptionId: subscription.id,
        outcome: "failed",
        delivered: false,
        attempts: attemptsMade,
        responseStatus: lastStatus,
        duplicate: false,
        error: errorMsg,
      };
    }
  }

  private async alreadyDelivered(subscriptionId: string, eventId: string): Promise<boolean> {
    const existing = await this.dataSource
      .getRepository(WebhookDeliveryLog)
      .findOne({ where: { subscriptionId, eventId, delivered: true } });
    if (existing !== null) return true;
    if (this.dataSource.options?.type !== "postgres") return false;
    const receipts = await this.dataSource.query(
      `SELECT 1 FROM event_replay_receipts WHERE source = $1 AND scope = $2 AND event_id = $3`,
      ["webhook_delivery_logs", subscriptionId, eventId]
    );
    return receipts.length > 0;
  }

  private async logDelivery(
    subscriptionId: string,
    eventType: string,
    eventId: string | undefined,
    attempt: number,
    responseStatus: number | null,
    delivered: boolean,
    errorMessage: string | null
  ): Promise<void> {
    try {
      await this.dataSource.getRepository(WebhookDeliveryLog).save({
        subscriptionId,
        eventType,
        eventId: eventId ?? null,
        attempt,
        responseStatus,
        delivered,
        errorMessage,
      });
    } catch (error) {
      this.appLogger.warn("webhook.delivery.log_failed", {
        subscription_id: subscriptionId,
        event_type: eventType,
        event_id: eventId ?? null,
        attempt,
        error: error instanceof Error ? error.message : "Failed to persist delivery log",
      });
    }
    this.appLogger.info("webhook.delivery.attempt", {
      subscription_id: subscriptionId,
      event_type: eventType,
      event_id: eventId ?? null,
      attempt,
      response_status: responseStatus,
      delivered,
    });
  }
}

export function createWebhookDispatcherService(
  dataSource: DataSource,
  appLogger?: AppLogger,
  options?: WebhookDispatcherOptions
): WebhookDispatcherService {
  return new WebhookDispatcherService(dataSource, appLogger, options);
}
