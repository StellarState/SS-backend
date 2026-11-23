import RedisMock from "ioredis-mock";
import type Redis from "ioredis";
import { InvoiceCacheService } from "../../src/services/invoice-cache.service";
import { cacheKey, type CacheContext } from "../../src/lib/cache-key";
import { runWithRequestContext } from "../../src/observability/request-context";
import { TtlCache } from "../../src/lib/ttl-cache";

const mainnet: CacheContext = { network: "mainnet", tenantId: "default", walletScope: "seller" };
const testnet: CacheContext = { ...mainnet, network: "testnet" };

describe("versioned network and tenant cache contexts (#862)", () => {
  it("isolates network, tenant, wallet, schema and arbitrary delimiters", () => {
    const keys = [
      cacheKey("invoices", mainnet, ["detail", "id"]),
      cacheKey("invoices", testnet, ["detail", "id"]),
      cacheKey("invoices", { ...mainnet, tenantId: "other" }, ["detail", "id"]),
      cacheKey("invoices", { ...mainnet, walletScope: "other" }, ["detail", "id"]),
      cacheKey("invoices", mainnet, ["detail", "id"], "3"),
      cacheKey("invoices", { ...mainnet, tenantId: "a:b", walletScope: "c" }, ["detail", "id"]),
      cacheKey("invoices", { ...mainnet, tenantId: "a", walletScope: "b:c" }, ["detail", "id"]),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(() => cacheKey("invoices", { ...mainnet, walletScope: "" }, [])).toThrow();
  });

  it("invalidates only the mutation context across Redis clients and variants", async () => {
    const redis = new RedisMock() as unknown as Redis;
    const writer = new InvoiceCacheService({ redisClient: redis });
    const reader = new InvoiceCacheService({ redisClient: redis });
    const newer = new InvoiceCacheService({ redisClient: redis, schemaVersion: "3" });
    const tenant = { ...mainnet, tenantId: "other" };
    await writer.setInvoiceDetail("seller", "id", { value: "mainnet" }, undefined, mainnet);
    await writer.setInvoiceDetail("seller", "id", { value: "testnet" }, undefined, testnet);
    await writer.setInvoiceDetail("seller", "id", { value: "tenant" }, undefined, tenant);
    await newer.setInvoiceDetail("seller", "id", { value: "new schema" }, undefined, mainnet);
    await writer.setInvoicesList("seller", 1, 20, undefined, {}, undefined, mainnet);
    await writer.setInvoicesList("seller", 2, 10, "draft", {}, undefined, mainnet);
    await writer.invalidateInvoice("id", "seller", mainnet);
    expect(await reader.getInvoiceDetail("seller", "id", mainnet)).toBeNull();
    expect(await reader.getInvoicesList("seller", 1, 20, undefined, mainnet)).toBeNull();
    expect(await reader.getInvoicesList("seller", 2, 10, "draft", mainnet)).toBeNull();
    expect(await reader.getInvoiceDetail("seller", "id", testnet)).toContain("testnet");
    expect(await reader.getInvoiceDetail("seller", "id", tenant)).toContain("tenant");
    expect(await newer.getInvoiceDetail("seller", "id", mainnet)).toContain("new schema");
    await redis.quit();
  });

  it("does not revive a local value after authoritative Redis deletion or failure", async () => {
    const redis = new RedisMock() as unknown as Redis;
    const cache = new InvoiceCacheService({ redisClient: redis });
    await cache.setInvoiceDetail("seller", "id", { value: "old" }, undefined, mainnet);
    await redis.flushall();
    expect(await cache.getInvoiceDetail("seller", "id", mainnet)).toBeNull();
    jest.spyOn(redis, "get").mockRejectedValue(new Error("offline"));
    expect(await cache.getInvoiceDetail("seller", "id", mainnet)).toBeNull();
    await redis.quit();
  });

  it("scopes general projection cache reads and invalidation by request network", async () => {
    const cache = new TtlCache({ ttlSeconds: 30, sweepIntervalMs: 0 });
    const on = <T>(network: "mainnet" | "testnet", fn: () => T) =>
      runWithRequestContext({ correlationId: "test", stellarNetwork: network }, fn);
    await on("mainnet", () => cache.set("wallet:key", { value: "mainnet" }));
    await on("testnet", () => cache.set("wallet:key", { value: "testnet" }));
    await on("mainnet", () => cache.invalidatePrefix("wallet:"));
    expect(await on("mainnet", () => cache.get("wallet:key"))).toBeNull();
    expect(await on("testnet", () => cache.get("wallet:key"))).toEqual({ value: "testnet" });
    cache.close();
  });
});
