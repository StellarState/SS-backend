import {
  WebhookDispatcherService,
  generateWebhookSignature,
} from "../src/services/webhook-dispatcher.service";
import { WebhookSubscription } from "../src/models/WebhookSubscription.model";
import { WebhookDeliveryLog } from "../src/models/WebhookDeliveryLog.model";

describe("WebhookDispatcherService", () => {
  const subscription = {
    id: "sub-1",
    url: "https://example.test/hook",
    secret: "secret",
    eventTypes: ["invoice.published"],
    active: true,
  } as WebhookSubscription;
  const log = {
    save: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn().mockResolvedValue(null),
  };
  const dataSource = {
    options: { type: "sqlite" },
    getRepository: jest.fn((entity) =>
      entity === WebhookSubscription ? { find: jest.fn().mockResolvedValue([subscription]) } : log
    ),
  };

  beforeEach(() => {
    log.save.mockReset().mockResolvedValue(undefined);
    log.findOne.mockReset().mockResolvedValue(null);
  });

  afterEach(() => jest.restoreAllMocks());

  it("generates a deterministic HMAC signature", () =>
    expect(generateWebhookSignature("payload", "secret")).toBe(
      "b82fcb791acec57859b989b430a826488ce2e479fdf92326bd0a2e8375a42ba4"
    ));

  it("posts signed event payloads and records delivery", async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 202 }) as any;
    const result = await new WebhookDispatcherService(dataSource as any).dispatchWebhookEvent(
      "invoice.published",
      { id: "invoice-1" }
    );
    expect(result[0]).toMatchObject({
      delivered: true,
      acknowledged: true,
      auditPersisted: true,
      reconciliationRequired: false,
      attempts: 1,
      responseStatus: 202,
    });
    expect(global.fetch).toHaveBeenCalledWith(
      subscription.url,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-signature": expect.any(String) }),
      })
    );
    expect(log.save).toHaveBeenCalledWith(expect.objectContaining({ delivered: true }));
  });

  it("retries non-2xx responses three times", async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 500 }) as any;
    const result = await new WebhookDispatcherService(dataSource as any).dispatchWebhookEvent(
      "invoice.published",
      {}
    );
    expect(result[0]).toMatchObject({
      delivered: false,
      acknowledged: false,
      auditPersisted: true,
      reconciliationRequired: false,
      attempts: 3,
      responseStatus: 500,
    });
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("retries fetch transport errors three times without claiming acknowledgement", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("ECONNRESET")) as any;
    const result = await new WebhookDispatcherService(dataSource as any).dispatchWebhookEvent(
      "invoice.published",
      { id: "invoice-2" },
      "evt-transport-1"
    );

    expect(result[0]).toMatchObject({
      subscriptionId: subscription.id,
      delivered: false,
      acknowledged: false,
      auditPersisted: true,
      reconciliationRequired: false,
      attempts: 3,
      responseStatus: null,
    });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(log.save).toHaveBeenCalledTimes(3);
    expect(log.save).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: subscription.id,
        eventId: "evt-transport-1",
        responseStatus: null,
        delivered: false,
        errorMessage: "ECONNRESET",
      })
    );
  });

  it("does not replay a 2xx delivery when audit persistence fails and exposes reconciliation state", async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 202 }) as any;
    log.save.mockRejectedValueOnce(new Error("audit db unavailable"));

    const dispatcher = new WebhookDispatcherService(dataSource as any);
    const result = await dispatcher.dispatchWebhookEvent(
      "invoice.published",
      { id: "invoice-3" },
      "evt-audit-fail-1"
    );

    // No immediate duplicate POST after 2xx acknowledgement.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // Preserves remote acknowledgement and status without claiming durable delivery.
    expect(result[0]).toMatchObject({
      subscriptionId: subscription.id,
      delivered: false,
      acknowledged: true,
      auditPersisted: false,
      reconciliationRequired: true,
      auditError: "audit db unavailable",
      attempts: 1,
      responseStatus: 202,
      duplicate: false,
    });

    const pending = dispatcher.getPendingReconciliations();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      subscriptionId: subscription.id,
      eventType: "invoice.published",
      eventId: "evt-audit-fail-1",
      attempt: 1,
      responseStatus: 202,
      acknowledged: true,
      errorMessage: null,
      auditError: "audit db unavailable",
    });

    // A subsequent dispatch of the same eventId before reconciliation does not re-POST.
    const duplicate = await dispatcher.dispatchWebhookEvent(
      "invoice.published",
      { id: "invoice-3" },
      "evt-audit-fail-1"
    );
    expect(duplicate[0]).toMatchObject({
      subscriptionId: subscription.id,
      delivered: false,
      duplicate: true,
      attempts: 0,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Failed reconciliation keeps the pending entry.
    log.save.mockRejectedValueOnce(new Error("audit db still down"));
    const failedReconcile = await dispatcher.reconcilePendingDeliveries();
    expect(failedReconcile).toEqual({ reconciled: 0, failed: 1 });
    expect(dispatcher.getPendingReconciliations()).toHaveLength(1);

    // Once audit persistence recovers, reconciliation writes the original delivery identity.
    log.save.mockResolvedValueOnce(undefined);
    const recoveredReconcile = await dispatcher.reconcilePendingDeliveries();
    expect(recoveredReconcile).toEqual({ reconciled: 1, failed: 0 });
    expect(dispatcher.getPendingReconciliations()).toHaveLength(0);
    expect(log.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        subscriptionId: subscription.id,
        eventType: "invoice.published",
        eventId: "evt-audit-fail-1",
        attempt: 1,
        responseStatus: 202,
        delivered: true,
        errorMessage: null,
      })
    );
  });

  it("does not reject dispatch when audit persistence fails during transport errors", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network timeout")) as any;
    log.save.mockRejectedValue(new Error("audit store offline"));

    const dispatcher = new WebhookDispatcherService(dataSource as any);
    const result = await dispatcher.dispatchWebhookEvent(
      "invoice.published",
      { id: "invoice-4" },
      "evt-double-fail-1"
    );

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(result[0]).toMatchObject({
      subscriptionId: subscription.id,
      delivered: false,
      acknowledged: false,
      auditPersisted: false,
      reconciliationRequired: true,
      auditError: "audit store offline",
      attempts: 3,
      responseStatus: null,
    });
    expect(dispatcher.getPendingReconciliations()).toHaveLength(3);
  });
});
