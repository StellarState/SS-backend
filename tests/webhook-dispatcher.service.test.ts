import {
  WebhookDispatcherService,
  generateWebhookSignature,
} from "../src/services/webhook-dispatcher.service";
import { WebhookSubscription } from "../src/models/WebhookSubscription.model";

function makeSubscription(id: string, eventTypes = ["invoice.published"]): WebhookSubscription {
  return {
    id,
    url: `https://example.test/hook/${id}`,
    secret: `secret-${id}`,
    eventTypes,
    active: true,
  } as WebhookSubscription;
}

function createPagedDataSource(
  subscriptions: WebhookSubscription[],
  logSave: jest.Mock = jest.fn().mockResolvedValue(undefined)
) {
  const findMock = jest.fn(
    async (options?: { skip?: number; take?: number; where?: { active?: boolean } }) => {
      const activeOnly = subscriptions.filter((s) => s.active);
      const skip = options?.skip ?? 0;
      const take = options?.take ?? activeOnly.length;
      return activeOnly.slice(skip, skip + take);
    }
  );
  const logRepo = {
    save: logSave,
    findOne: jest.fn().mockResolvedValue(null),
  };
  const dataSource = {
    options: { type: "sqlite" },
    getRepository: jest.fn((entity) =>
      entity === WebhookSubscription ? { find: findMock } : logRepo
    ),
  };
  return { dataSource, findMock, logRepo };
}

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
    const result = await new WebhookDispatcherService(dataSource as any, undefined, {
      retryBaseDelayMs: 1,
    }).dispatchWebhookEvent("invoice.published", {});
    expect(result[0]).toMatchObject({
      outcome: "failed",
      delivered: false,
      attempts: 3,
      responseStatus: 500,
    });
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("preserves successful outcomes when another subscription or audit log write fails", async () => {
    const subscriptions = [
      makeSubscription("sub-ok-1"),
      makeSubscription("sub-log-fail"),
      makeSubscription("sub-http-fail"),
      makeSubscription("sub-ok-2"),
    ];

    const logSave = jest.fn(async (row: { subscriptionId: string }) => {
      if (row.subscriptionId === "sub-log-fail") {
        throw new Error("DB write timeout");
      }
    });

    const { dataSource: ds } = createPagedDataSource(subscriptions, logSave);

    global.fetch = jest.fn(async (url: string) => {
      if (url.endsWith("/sub-http-fail")) {
        return { status: 503 };
      }
      return { status: 200 };
    }) as any;

    const dispatcher = new WebhookDispatcherService(ds as any, undefined, {
      maxConcurrency: 2,
      pageSize: 10,
      retryBaseDelayMs: 1,
    });

    const results = await dispatcher.dispatchWebhookEvent("invoice.published", { id: "inv-1" });
    const byId = new Map(results.map((r) => [r.subscriptionId, r]));

    expect(results).toHaveLength(4);
    expect(byId.get("sub-ok-1")).toMatchObject({ outcome: "succeeded", delivered: true });
    expect(byId.get("sub-log-fail")).toMatchObject({ outcome: "succeeded", delivered: true });
    expect(byId.get("sub-http-fail")).toMatchObject({
      outcome: "failed",
      delivered: false,
      attempts: 3,
      responseStatus: 503,
    });
    expect(byId.get("sub-ok-2")).toMatchObject({ outcome: "succeeded", delivered: true });
  });

  it("enforces bounded active HTTP concurrency under load (including retries)", async () => {
    const subscriptions = Array.from({ length: 40 }, (_, i) =>
      makeSubscription(`sub-${String(i).padStart(3, "0")}`)
    );
    const { dataSource: ds } = createPagedDataSource(subscriptions);

    let activeRequests = 0;
    let peakActiveRequests = 0;
    const attemptsByUrl = new Map<string, number>();

    global.fetch = jest.fn(async (url: string) => {
      activeRequests += 1;
      peakActiveRequests = Math.max(peakActiveRequests, activeRequests);
      const count = (attemptsByUrl.get(url) ?? 0) + 1;
      attemptsByUrl.set(url, count);

      await new Promise((resolve) => setTimeout(resolve, 5));
      activeRequests -= 1;

      // Every 3rd subscription fails its first two attempts to exercise retries
      const index = Number(url.slice(-3));
      if (index % 3 === 0 && count < 3) {
        return { status: 502 };
      }
      return { status: 200 };
    }) as any;

    const maxConcurrency = 4;
    const dispatcher = new WebhookDispatcherService(ds as any, undefined, {
      maxConcurrency,
      pageSize: 20,
      retryBaseDelayMs: 2,
    });

    const results = await dispatcher.dispatchWebhookEvent("invoice.published", { id: "load-1" });

    expect(results).toHaveLength(40);
    expect(results.every((r) => r.outcome === "succeeded" && r.delivered)).toBe(true);
    expect(peakActiveRequests).toBeLessThanOrEqual(maxConcurrency);
    expect(peakActiveRequests).toBeGreaterThan(1);
    expect(dispatcher.getActiveRequestCount()).toBe(0);
  });

  it("fetches large subscription sets in bounded pages", async () => {
    const subscriptions = Array.from({ length: 125 }, (_, i) =>
      makeSubscription(
        `sub-${String(i).padStart(3, "0")}`,
        i % 5 === 0 ? ["other.event"] : ["invoice.published"]
      )
    );
    const { dataSource: ds, findMock } = createPagedDataSource(subscriptions);

    global.fetch = jest.fn().mockResolvedValue({ status: 200 }) as any;

    const pageSize = 25;
    const dispatcher = new WebhookDispatcherService(ds as any, undefined, {
      maxConcurrency: 8,
      pageSize,
    });

    const results = await dispatcher.dispatchWebhookEvent("invoice.published", { id: "paged-1" });

    // 125 active subscriptions with pageSize 25 => 5 full pages + 1 terminating empty page = 6 calls
    expect(findMock).toHaveBeenCalledTimes(6);
    for (let i = 0; i < 6; i++) {
      expect(findMock).toHaveBeenNthCalledWith(
        i + 1,
        expect.objectContaining({
          where: { active: true },
          skip: i * pageSize,
          take: pageSize,
        })
      );
    }

    // 100 of 125 subscriptions match "invoice.published"
    expect(results).toHaveLength(100);
    expect(results.every((r) => r.outcome === "succeeded" && r.delivered)).toBe(true);
  });

  it("defers remaining work on shutdown and allows safe inspection and resumption", async () => {
    const subscriptions = Array.from({ length: 20 }, (_, i) =>
      makeSubscription(`sub-${String(i).padStart(2, "0")}`)
    );
    const { dataSource: ds } = createPagedDataSource(subscriptions);

    const deliveredIds: string[] = [];
    let dispatcher!: WebhookDispatcherService;

    global.fetch = jest.fn(async (url: string) => {
      const id = url.split("/").pop()!;
      await new Promise((resolve) => setTimeout(resolve, 5));
      deliveredIds.push(id);
      if (deliveredIds.length === 4) {
        dispatcher.shutdown();
      }
      return { status: 200 };
    }) as any;

    dispatcher = new WebhookDispatcherService(ds as any, undefined, {
      maxConcurrency: 2,
      pageSize: 10,
      retryBaseDelayMs: 1,
    });

    const firstRun = await dispatcher.dispatchWebhookEvent(
      "invoice.published",
      { id: "shutdown-1" },
      "evt-shutdown-1"
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
