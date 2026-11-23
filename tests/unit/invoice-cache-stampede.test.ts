import RedisMock from "ioredis-mock";
import Redis from "ioredis";
import { InvoiceCacheService } from "../../src/services/invoice-cache.service";
import { MetricsRegistry } from "../../src/observability/metrics";
import { setReliabilityMetricsRegistry } from "../../src/observability/reliability-metrics";
import type { CacheContext } from "../../src/lib/cache-key";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const context: CacheContext = { network: "testnet", tenantId: "test", walletScope: "seller" };
const nativeDescribe = process.env.INVOICE_CACHE_TEST_REDIS_URL ? describe : describe.skip;

describe("bounded invoice cache populations (#863)", () => {
  beforeEach(async () => {
    const redis = new RedisMock();
    await redis.flushall();
    await redis.quit();
  });
  afterEach(() => setReliabilityMetricsRegistry(undefined));
  it("reduces 200 concurrent misses to one database load and records hits/coalescing", async () => {
    const metrics = new MetricsRegistry();
    setReliabilityMetricsRegistry(metrics);
    const cache = new InvoiceCacheService();
    const loader = jest.fn(async () => {
      await sleep(20);
      return { value: "fresh" };
    });
    const responses = await Promise.all(
      Array.from({ length: 200 }, () =>
        cache.getOrLoadInvoicesList("seller", 1, 20, undefined, loader, context)
      )
    );
    expect(loader).toHaveBeenCalledTimes(1);
    expect(responses.filter((item) => item.state === "COALESCED")).toHaveLength(199);
    expect(
      (await cache.getOrLoadInvoicesList("seller", 1, 20, undefined, loader, context)).state
    ).toBe("HIT");
    expect(metrics.renderPrometheusMetrics()).toContain(
      "stellarsettle_invoice_cache_populations_total 1"
    );
    expect(metrics.renderPrometheusMetrics()).toContain(
      "stellarsettle_invoice_cache_coalesced_total 199"
    );
    console.info("invoice cache load benchmark", {
      requests: 200,
      databaseLoads: loader.mock.calls.length,
      reductionPercent: 99.5,
    });
  });

  it("rejects superseded fills instead of serving or caching their stale results", async () => {
    const cache = new InvoiceCacheService();
    let complete!: (value: unknown) => void;
    const first = cache.getOrLoadInvoiceDetail(
      "seller",
      "id",
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      context
    );
    const assertion = expect(first).rejects.toMatchObject({ statusCode: 503 });
    await sleep(5);
    await cache.invalidateInvoice("id", "seller", context);
    complete({ value: "stale" });
    await assertion;
    expect(await cache.getInvoiceDetail("seller", "id", context)).toBeNull();
    const fresh = await cache.getOrLoadInvoiceDetail(
      "seller",
      "id",
      async () => ({ value: "fresh" }),
      context
    );
    expect(fresh.value).toContain("fresh");
  });

  it("bounds fallback concurrency, waiters and timed out operations", async () => {
    const cache = new InvoiceCacheService({
      maxInFlight: 1,
      maxWaitersPerKey: 2,
      loadTimeoutMs: 20,
      redisClient: { get: jest.fn().mockRejectedValue(new Error("offline")) } as any,
    });
    let complete!: (value: unknown) => void;
    const loader = jest.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const first = cache.getOrLoadInvoiceDetail("seller", "id", loader, context);
    const second = cache.getOrLoadInvoiceDetail("seller", "id", loader, context);
    const outcomes = Promise.allSettled([first, second]);
    await expect(
      cache.getOrLoadInvoiceDetail("seller", "id", loader, context)
    ).rejects.toMatchObject({ statusCode: 503 });
    await expect(
      cache.getOrLoadInvoiceDetail("seller", "other", loader, context)
    ).rejects.toMatchObject({ statusCode: 503 });
    expect((await outcomes).every((outcome) => outcome.status === "rejected")).toBe(true);
    await expect(
      cache.getOrLoadInvoiceDetail("seller", "id", loader, context)
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(loader).toHaveBeenCalledTimes(1);
    complete({ value: "late" });
    await sleep(5);
    const fresh = await cache.getOrLoadInvoiceDetail(
      "seller",
      "id",
      async () => ({ value: "fresh" }),
      context
    );
    expect(fresh.value).toContain("fresh");
  });

  it("keeps mutations available and bypasses Redis after failed invalidation", async () => {
    const redis = new RedisMock() as unknown as Redis;
    const cache = new InvoiceCacheService({ redisClient: redis });
    await cache.setInvoiceDetail("seller", "id", { value: "old" }, undefined, context);
    jest.spyOn(redis, "incr").mockRejectedValueOnce(new Error("offline"));
    await expect(cache.invalidateInvoice("id", "seller", context)).resolves.toBeUndefined();
    const loader = jest.fn(async () => ({ value: "fresh" }));
    expect((await cache.getOrLoadInvoiceDetail("seller", "id", loader, context)).value).toContain(
      "fresh"
    );
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await cache.getInvoiceDetail("seller", "id", context)).toBeNull();
    await redis.quit();
  });

  it("does not cache loader failures and isolates networks during simultaneous fills", async () => {
    const redis = new RedisMock() as unknown as Redis;
    const cache = new InvoiceCacheService({ redisClient: redis });
    await expect(
      cache.getOrLoadInvoiceDetail(
        "seller",
        "id",
        async () => {
          throw new Error("database error");
        },
        context
      )
    ).rejects.toThrow("database error");
    const values = await Promise.all([
      cache.getOrLoadInvoiceDetail("seller", "id", async () => ({ network: "testnet" }), context),
      cache.getOrLoadInvoiceDetail("seller", "id", async () => ({ network: "mainnet" }), {
        ...context,
        network: "mainnet",
      }),
    ]);
    expect(values[0].value).toContain("testnet");
    expect(values[1].value).toContain("mainnet");
    await redis.quit();
  });
});

nativeDescribe("Redis lease fencing across API instances (#863)", () => {
  let redis: Redis;
  beforeEach(async () => {
    redis = new Redis(process.env.INVOICE_CACHE_TEST_REDIS_URL!, {
      maxRetriesPerRequest: 1,
      commandTimeout: 1000,
    });
    await redis.flushdb();
  });
  afterEach(async () => {
    await redis.quit();
  });

  it("populates one shared key once across eight API instances", async () => {
    const clients = Array.from(
      { length: 8 },
      () => new InvoiceCacheService({ redisClient: redis })
    );
    const loader = jest.fn(async () => {
      await sleep(75);
      return { value: "fresh" };
    });
    const values = await Promise.all(
      Array.from({ length: 80 }, (_, index) =>
        clients[index % clients.length].getOrLoadInvoiceDetail("seller", "shared", loader, context)
      )
    );
    expect(loader).toHaveBeenCalledTimes(1);
    expect(values.every((item) => item.value.includes("fresh"))).toBe(true);
    console.info("distributed invoice cache load benchmark", {
      requests: 80,
      instances: 8,
      databaseLoads: loader.mock.calls.length,
    });
  });

  it("rejects an expired owner and cannot overwrite the replacement owner's value", async () => {
    const old = new InvoiceCacheService({ redisClient: redis, leaseMs: 20 });
    const replacement = new InvoiceCacheService({ redisClient: redis });
    const stale = old.getOrLoadInvoiceDetail(
      "seller",
      "expired",
      async () => {
        await sleep(100);
        return { value: "stale" };
      },
      context
    );
    const assertion = expect(stale).rejects.toMatchObject({ statusCode: 503 });
    await sleep(50);
    const fresh = await replacement.getOrLoadInvoiceDetail(
      "seller",
      "expired",
      async () => ({ value: "fresh" }),
      context
    );
    expect(fresh.value).toContain("fresh");
    await assertion;
    expect(await replacement.getInvoiceDetail("seller", "expired", context)).toContain("fresh");
  });

  it("fences mutation races across clients and times out waiters without database fallback", async () => {
    const first = new InvoiceCacheService({ redisClient: redis });
    const second = new InvoiceCacheService({ redisClient: redis, waitTimeoutMs: 25 });
    let complete!: (value: unknown) => void;
    const old = first.getOrLoadInvoiceDetail(
      "seller",
      "mutation",
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      context
    );
    const assertion = expect(old).rejects.toMatchObject({ statusCode: 503 });
    await sleep(10);
    const unused = jest.fn(async () => ({}));
    await expect(
      second.getOrLoadInvoiceDetail("seller", "mutation", unused, context)
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(unused).not.toHaveBeenCalled();
    await second.invalidateInvoice("mutation", "seller", context);
    complete({ value: "stale" });
    await assertion;
    expect(await first.getInvoiceDetail("seller", "mutation", context)).toBeNull();
  });
});
