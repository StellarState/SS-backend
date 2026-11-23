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

export interface WebhookPendingAuditReconciliation {
  subscriptionId: string;
  eventType: string;
  eventId: string | null;
  attempt: number;
  responseStatus: number | null;
  acknowledged: boolean;
  errorMessage: string | null;
  auditError: string;
  recordedAt: string;
}

export interface WebhookReconciliationSummary {
  reconciled: number;
  failed: number;
}

export interface WebhookDispatchResult {
  subscriptionId: string;
  /**
   * `true` only when the remote endpoint acknowledged the webhook (2xx) and
   * the delivery audit record was durably persisted.
   */
  delivered: boolean;
  /**
   * `true` when the remote endpoint returned a 2xx response, independent of
   * whether local audit persistence succeeded.
   */
  acknowledged: boolean;
  /**
   * `true` when local audit persistence succeeded for the delivery outcome.
   */
  auditPersisted: boolean;
  /**
   * `true` when local audit persistence failed and reconciliation is required.
   */
  reconciliationRequired: boolean;
  auditError?: string | null;
  attempts: number;
  responseStatus: number | null;
  /**
   * `true` when the event was already delivered for this subscription and was
   * therefore skipped. A duplicate response lets callers/logs identify the
   * event as already handled instead of re-triggering downstream side effects.
   */
  duplicate?: boolean;
}

export class WebhookDispatcherService {
  private readonly pendingReconciliations: WebhookPendingAuditReconciliation[] = [];

  constructor(
    private readonly dataSource: DataSource,
    private readonly appLogger: AppLogger = logger
  ) {}

  getPendingReconciliations(): WebhookPendingAuditReconciliation[] {
    return this.pendingReconciliations.map((entry) => ({ ...entry }));
  }

  async reconcilePendingDeliveries(): Promise<WebhookReconciliationSummary> {
    let reconciled = 0;
    let failed = 0;

    for (let i = 0; i < this.pendingReconciliations.length; ) {
      const entry = this.pendingReconciliations[i];
      try {
        await this.logDelivery(
          entry.subscriptionId,
          entry.eventType,
          entry.eventId ?? undefined,
          entry.attempt,
          entry.responseStatus,
          entry.acknowledged,
          entry.errorMessage
        );
        this.pendingReconciliations.splice(i, 1);
        reconciled++;
      } catch (error) {
        entry.auditError =
          error instanceof Error ? error.message : "Failed to persist webhook delivery audit";
        this.appLogger.error("webhook.delivery.reconciliation_failed", {
          subscription_id: entry.subscriptionId,
          event_type: entry.eventType,
          event_id: entry.eventId,
          attempt: entry.attempt,
          response_status: entry.responseStatus,
          acknowledged: entry.acknowledged,
          audit_error: entry.auditError,
        });
        failed++;
        i++;
      }
    }

    return { reconciled, failed };
  }

  async dispatchWebhookEvent(
    eventType: string,
    payload: unknown,
    eventId?: string
  ): Promise<WebhookDispatchResult[]> {
    const subscriptions = await this.dataSource
      .getRepository(WebhookSubscription)
      .find({ where: { active: true } });
    const body = JSON.stringify({ eventType, payload });
    const eligible = subscriptions.filter((subscription) =>
      subscription.eventTypes.includes(eventType)
    );
    return Promise.all(
      eligible.map((subscription) => this.deliver(subscription, eventType, body, eventId))
    );
  }

  private async deliver(
    subscription: WebhookSubscription,
    eventType: string,
    body: string,
    eventId?: string
  ): Promise<WebhookDispatchResult> {
    if (eventId && (await this.alreadyDelivered(subscription.id, eventId))) {
      this.appLogger.info("webhook.event.already_handled", {
        subscription_id: subscription.id,
        event_type: eventType,
        event_id: eventId,
      });
      return {
        subscriptionId: subscription.id,
        delivered: false,
        acknowledged: false,
        auditPersisted: true,
        reconciliationRequired: false,
        attempts: 0,
        responseStatus: null,
        duplicate: true,
      };
    }

    try {
      validateWebhookUrl(subscription.url);
    } catch (error) {
      const errorMsg = error instanceof UrlValidationError ? error.message : "URL validation failed";
      this.appLogger.warn("webhook.url.validation_failed", {
        subscription_id: subscription.id,
        url: subscription.url,
        error: errorMsg,
      });
      const auditResult = await this.tryLogDelivery(
        subscription.id,
        eventType,
        eventId,
        0,
        null,
        false,
        errorMsg
      );
      return {
        subscriptionId: subscription.id,
        delivered: false,
        acknowledged: false,
        auditPersisted: auditResult.persisted,
        reconciliationRequired: !auditResult.persisted,
        ...(auditResult.auditError ? { auditError: auditResult.auditError } : {}),
        attempts: 0,
        responseStatus: null,
        duplicate: false,
      };
    }

    let lastStatus: number | null = null;
    let lastError: string | null = null;
    let lastAuditError: string | null = null;
    let anyAuditFailure = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      let responseStatus: number | null = null;
      let acknowledged = false;
      let attemptError: string | null = null;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
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
        responseStatus = response.status;
        lastStatus = response.status;
        acknowledged = response.status >= 200 && response.status < 300;
        if (!acknowledged) {
          attemptError = `HTTP ${response.status}`;
          lastError = attemptError;
        }
      } catch (error) {
        attemptError = error instanceof Error ? error.message : "Webhook request failed";
        lastError = attemptError;
      } finally {
        clearTimeout(timer);
      }

      const auditResult = await this.tryLogDelivery(
        subscription.id,
        eventType,
        eventId,
        attempt,
        responseStatus,
        acknowledged,
        attemptError
      );

      if (!auditResult.persisted) {
        anyAuditFailure = true;
        lastAuditError = auditResult.auditError;
      }

      if (acknowledged) {
        return {
          subscriptionId: subscription.id,
          delivered: auditResult.persisted,
          acknowledged: true,
          auditPersisted: auditResult.persisted,
          reconciliationRequired: !auditResult.persisted,
          ...(auditResult.auditError ? { auditError: auditResult.auditError } : {}),
          attempts: attempt,
          responseStatus,
          duplicate: false,
        };
      }

      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
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
      delivered: false,
      acknowledged: false,
      auditPersisted: !anyAuditFailure,
      reconciliationRequired: anyAuditFailure,
      ...(lastAuditError ? { auditError: lastAuditError } : {}),
      attempts: 3,
      responseStatus: lastStatus,
      duplicate: false,
    };
  }

  private async alreadyDelivered(subscriptionId: string, eventId: string): Promise<boolean> {
    if (
      this.pendingReconciliations.some(
        (entry) =>
          entry.subscriptionId === subscriptionId &&
          entry.eventId === eventId &&
          entry.acknowledged
      )
    ) {
      return true;
    }
    const existing = await this.dataSource
      .getRepository(WebhookDeliveryLog)
      .findOne({ where: { subscriptionId, eventId, delivered: true } });
    if (existing !== null) return true;
    if (this.dataSource.options.type !== "postgres") return false;
    const receipts = await this.dataSource.query(
      `SELECT 1 FROM event_replay_receipts WHERE source = $1 AND scope = $2 AND event_id = $3`,
      ["webhook_delivery_logs", subscriptionId, eventId],
    );
    return receipts.length > 0;
  }

  private async tryLogDelivery(
    subscriptionId: string,
    eventType: string,
    eventId: string | undefined,
    attempt: number,
    responseStatus: number | null,
    acknowledged: boolean,
    errorMessage: string | null
  ): Promise<{ persisted: boolean; auditError: string | null }> {
    try {
      await this.logDelivery(
        subscriptionId,
        eventType,
        eventId,
        attempt,
        responseStatus,
        acknowledged,
        errorMessage
      );
      return { persisted: true, auditError: null };
    } catch (error) {
      const auditError =
        error instanceof Error ? error.message : "Failed to persist webhook delivery audit";
      const record: WebhookPendingAuditReconciliation = {
        subscriptionId,
        eventType,
        eventId: eventId ?? null,
        attempt,
        responseStatus,
        acknowledged,
        errorMessage,
        auditError,
        recordedAt: new Date().toISOString(),
      };
      this.pendingReconciliations.push(record);
      this.appLogger.error("webhook.delivery.audit_failed", {
        subscription_id: subscriptionId,
        event_type: eventType,
        event_id: eventId ?? null,
        attempt,
        response_status: responseStatus,
        acknowledged,
        audit_error: auditError,
      });
      return { persisted: false, auditError };
    }
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
    await this.dataSource.getRepository(WebhookDeliveryLog).save({
      subscriptionId,
      eventType,
      eventId: eventId ?? null,
      attempt,
      responseStatus,
      delivered,
      errorMessage,
    });
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
  appLogger?: AppLogger
): WebhookDispatcherService {
  return new WebhookDispatcherService(dataSource, appLogger);
}
