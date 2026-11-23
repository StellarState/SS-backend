import { randomUUID } from "crypto";
import { AppError } from "../utils/http-error";
import { recordReliabilityMetric } from "../observability/reliability-metrics";
import Redis from "ioredis";
import {
  cacheContextPrefix,
  cacheKey,
  defaultCacheNetwork,
  type CacheContext,
} from "../lib/cache-key";
import { logger } from "../observability/logger";

export interface InvoiceCacheOptions {
  redisUrl?: string;
  redisClient?: Redis;
  listTtlSeconds?: number;
  detailTtlSeconds?: number;
  enabled?: boolean;
  schemaVersion?: string;
  maxEntries?: number;
  maxInFlight?: number;
  maxWaitersPerKey?: number;
  leaseMs?: number;
  waitTimeoutMs?: number;
  loadTimeoutMs?: number;
}

export interface CacheResult {
  value: string;
  state: "HIT" | "MISS" | "COALESCED";
}
interface Flight {
  promise: Promise<CacheResult>;
  waiters: number;
}

const PUBLISH_FILL = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
  if (redis.call('GET', KEYS[3]) or '0') ~= ARGV[2] then return 0 end
  redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
  redis.call('DEL', KEYS[1])
  return 1`;
const RELEASE_LEASE = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
  return 0`;

interface MemoryCacheEntry {
  value: string;
  expiresAt: number;
}

export class InvoiceCacheService {
  private readonly redis: Redis | null = null;
  private readonly memoryFallback = new Map<string, MemoryCacheEntry>();
  private readonly listTtlSeconds: number;
  private readonly detailTtlSeconds: number;
  private readonly enabled: boolean;
  private readonly generations = new Map<string, string>();
  private readonly schemaVersion: string;
  private readonly maxEntries: number;
  private readonly flights = new Map<string, Flight>();
  private readonly activeLoads = new Set<string>();
  private readonly maxInFlight: number;
  private readonly maxWaitersPerKey: number;
  private readonly leaseMs: number;
  private readonly waitTimeoutMs: number;
  private readonly loadTimeoutMs: number;
  private redisBypassUntil = 0;

  constructor(options: InvoiceCacheOptions = {}) {
    this.maxInFlight = options.maxInFlight ?? 64;
    this.maxWaitersPerKey = options.maxWaitersPerKey ?? 1000;
    this.leaseMs = options.leaseMs ?? 5000;
    this.waitTimeoutMs = options.waitTimeoutMs ?? 5000;
    this.loadTimeoutMs = options.loadTimeoutMs ?? 3000;
    this.schemaVersion = options.schemaVersion ?? "2";
    this.maxEntries = options.maxEntries ?? 1000;
    this.listTtlSeconds = options.listTtlSeconds ?? 30;
    this.detailTtlSeconds = options.detailTtlSeconds ?? 60;
    this.enabled = options.enabled !== false;
    if (
      ![
        this.maxEntries,
        this.maxInFlight,
        this.maxWaitersPerKey,
        this.leaseMs,
        this.waitTimeoutMs,
        this.loadTimeoutMs,
        this.listTtlSeconds,
        this.detailTtlSeconds,
      ].every((value) => Number.isSafeInteger(value) && value > 0) ||
      this.maxEntries > 10000 ||
      this.maxInFlight > 1000 ||
      this.maxWaitersPerKey > 10000 ||
      this.leaseMs > 30000 ||
      this.waitTimeoutMs > 30000 ||
      this.loadTimeoutMs > 30000
    ) {
      throw new Error("Invalid or unbounded invoice cache options");
    }

    if (options.redisClient) {
      this.redis = options.redisClient;
    } else if (options.redisUrl && this.enabled) {
      try {
        this.redis = new Redis(options.redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          connectTimeout: 2000,
          commandTimeout: 1000,
          retryStrategy: () => null, // Do not loop reconnecting if Redis is down
        });

        this.redis.on("connect", () => {
          logger.info("InvoiceCache: Redis connected");
        });

        this.redis.on("error", (err: unknown) => {
          logger.warn("InvoiceCache: Redis error, falling back gracefully", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } catch (err) {
        this.redis = null;

        logger.warn("InvoiceCache: Failed to initialize Redis client, falling back", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  public getListTtl(): number {
    return this.listTtlSeconds;
  }

  public getDetailTtl(): number {
    return this.detailTtlSeconds;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  private context(sellerId: string, context?: CacheContext): CacheContext {
    return (
      context ?? { network: defaultCacheNetwork(), tenantId: "default", walletScope: sellerId }
    );
  }

  private prefix(sellerId: string, context?: CacheContext): string {
    const resolved = this.context(sellerId, context);
    if (resolved.walletScope !== sellerId)
      throw new Error("Cache wallet scope does not match seller");
    const prefix = cacheContextPrefix("invoices", resolved, this.schemaVersion);
    if (!this.generations.has(prefix)) {
      while (this.generations.size >= this.maxEntries) {
        const oldest = this.generations.keys().next().value!;
        this.generations.delete(oldest);
        for (const key of this.memoryFallback.keys()) {
          if (key.startsWith(`${oldest}:`)) this.memoryFallback.delete(key);
        }
      }
      this.generations.set(prefix, randomUUID());
    }
    return prefix;
  }

  private async generation(prefix: string): Promise<string> {
    if (this.redis) return (await this.redis.get(`${prefix}:generation`)) ?? "0";
    return this.generations.get(prefix)!;
  }

  private async dataKey(
    sellerId: string,
    parts: unknown[],
    context?: CacheContext
  ): Promise<string> {
    const prefix = this.prefix(sellerId, context);
    return `${cacheKey("invoices", this.context(sellerId, context), parts, this.schemaVersion)}:g:${await this.generation(prefix)}`;
  }

  async getInvoicesList(
    sellerId: string,
    page: number,
    limit: number,
    status?: string,
    context?: CacheContext
  ): Promise<string | null> {
    if (!this.enabled) return null;
    try {
      return await this.get(
        await this.dataKey(sellerId, ["list", page, limit, status ?? null], context)
      );
    } catch {
      return null;
    }
  }

  async setInvoicesList(
    sellerId: string,
    page: number,
    limit: number,
    status: string | undefined,
    data: unknown,
    ttlSeconds?: number,
    context?: CacheContext
  ): Promise<void> {
    if (!this.enabled) return;
    await this.set(
      await this.dataKey(sellerId, ["list", page, limit, status ?? null], context),
      JSON.stringify(data),
      ttlSeconds ?? this.listTtlSeconds
    );
  }

  async getInvoiceDetail(
    sellerId: string,
    invoiceId: string,
    context?: CacheContext
  ): Promise<string | null> {
    if (!this.enabled) return null;
    try {
      return await this.get(await this.dataKey(sellerId, ["detail", invoiceId], context));
    } catch {
      return null;
    }
  }

  async setInvoiceDetail(
    sellerId: string,
    invoiceId: string,
    data: unknown,
    ttlSeconds?: number,
    context?: CacheContext
  ): Promise<void> {
    if (!this.enabled) return;
    await this.set(
      await this.dataKey(sellerId, ["detail", invoiceId], context),
      JSON.stringify(data),
      ttlSeconds ?? this.detailTtlSeconds
    );
  }

  async invalidateInvoice(
    _invoiceId: string,
    sellerId?: string,
    context?: CacheContext
  ): Promise<void> {
    if (!sellerId) throw new Error("Invoice invalidation requires its owner wallet scope");
    await this.invalidateSellerInvoices(sellerId, context);
  }

  async invalidateSellerInvoices(sellerId: string, context?: CacheContext): Promise<void> {
    if (!this.enabled) return;
    const prefix = this.prefix(sellerId, context);
    // Epoch changes invalidate every list/detail variant in this exact context.
    // Old generations expire naturally; invalidation never scans unrelated keys.
    this.generations.set(prefix, randomUUID());
    for (const key of this.memoryFallback.keys()) {
      if (key.startsWith(`${prefix}:`)) this.memoryFallback.delete(key);
    }
    if (this.redis) {
      try {
        await this.redis.incr(`${prefix}:generation`);
      } catch {
        // The mutation already committed. Bypass Redis until every potentially
        // superseded value/lease has expired instead of failing the mutation.
        this.redisBypassUntil =
          Date.now() + Math.max(this.listTtlSeconds, this.detailTtlSeconds) * 1000 + this.leaseMs;
        recordReliabilityMetric("invoice_cache_invalidation_failures");
        logger.warn(
          "InvoiceCache: Invalidation failed; bypassing Redis until cached values expire"
        );
      }
    }
  }

  async invalidateAll(): Promise<void> {
    // Operational reset is scoped to contexts observed by this instance.
    for (const prefix of this.generations.keys()) {
      this.generations.set(prefix, randomUUID());
      if (this.redis) await this.redis.incr(`${prefix}:generation`);
    }
    this.memoryFallback.clear();
  }

  getOrLoadInvoicesList(
    sellerId: string,
    page: number,
    limit: number,
    status: string | undefined,
    loader: () => Promise<unknown>,
    context?: CacheContext
  ): Promise<CacheResult> {
    return this.getOrLoad(
      sellerId,
      ["list", page, limit, status ?? null],
      this.listTtlSeconds,
      loader,
      context
    );
  }

  getOrLoadInvoiceDetail(
    sellerId: string,
    invoiceId: string,
    loader: () => Promise<unknown>,
    context?: CacheContext
  ): Promise<CacheResult> {
    return this.getOrLoad(sellerId, ["detail", invoiceId], this.detailTtlSeconds, loader, context);
  }

  private busy(message: string): AppError {
    recordReliabilityMetric("invoice_cache_rejected_requests");
    return new AppError(503, message, "CACHE_FILL_BUSY");
  }

  private async getOrLoad(
    sellerId: string,
    parts: unknown[],
    ttl: number,
    loader: () => Promise<unknown>,
    context?: CacheContext
  ): Promise<CacheResult> {
    const resolved = this.context(sellerId, context);
    const prefix = this.prefix(sellerId, resolved);
    const key = cacheKey("invoices", resolved, parts, this.schemaVersion);
    const existing = this.flights.get(key);
    if (existing) {
      if (existing.waiters >= this.maxWaitersPerKey)
        throw this.busy("Too many waiting cache requests");
      existing.waiters++;
      recordReliabilityMetric("invoice_cache_coalesced");
      try {
        return { ...(await existing.promise), state: "COALESCED" };
      } finally {
        existing.waiters--;
      }
    }
    if (this.flights.size >= this.maxInFlight || this.activeLoads.has(key)) {
      throw this.busy("Invoice cache population capacity reached");
    }
    const flight: Flight = { promise: this.populate(prefix, key, ttl, loader), waiters: 1 };
    this.flights.set(key, flight);
    const cleanup = () => {
      if (this.flights.get(key) === flight) this.flights.delete(key);
    };
    void flight.promise.then(cleanup, cleanup);
    return flight.promise;
  }

  private async loadBounded(key: string, loader: () => Promise<unknown>): Promise<string> {
    if (this.activeLoads.size >= this.maxInFlight || this.activeLoads.has(key)) {
      throw this.busy("Invoice database fallback capacity reached");
    }
    this.activeLoads.add(key);
    recordReliabilityMetric("invoice_cache_populations");
    const operation = Promise.resolve()
      .then(loader)
      .then((value) => JSON.stringify(value));
    // A timed out SQL operation still occupies its slot until it actually ends.
    // New requests cannot start replacement loads for the same key meanwhile.
    const cleanup = () => this.activeLoads.delete(key);
    void operation.then(cleanup, cleanup);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(this.busy("Invoice cache population timed out")),
            this.loadTimeoutMs
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async localPopulate(
    prefix: string,
    key: string,
    ttl: number,
    loader: () => Promise<unknown>
  ): Promise<CacheResult> {
    const generation = this.generations.get(prefix);
    const dataKey = `${key}:g:${generation}`;
    const cached = this.enabled && !this.redis ? await this.get(dataKey) : null;
    if (cached !== null) {
      recordReliabilityMetric("invoice_cache_hits");
      return { value: cached, state: "HIT" };
    }
    recordReliabilityMetric("invoice_cache_misses");
    const value = await this.loadBounded(key, loader);
    if (this.generations.get(prefix) !== generation)
      throw this.busy("Invoice cache context changed during population");
    // Never persist a fallback value when a Redis authority is configured.
    if (this.enabled && !this.redis) await this.set(dataKey, value, ttl);
    return { value, state: "MISS" };
  }

  private async populate(
    prefix: string,
    key: string,
    ttl: number,
    loader: () => Promise<unknown>
  ): Promise<CacheResult> {
    if (!this.redis || !this.enabled || Date.now() < this.redisBypassUntil)
      return this.localPopulate(prefix, key, ttl, loader);
    const redis = this.redis;
    const token = randomUUID();
    const deadline = Date.now() + this.waitTimeoutMs;
    let generation: string;
    let dataKey: string;
    let lockKey: string;
    let acquired: boolean;
    try {
      generation = await this.generation(prefix);
      dataKey = `${key}:g:${generation}`;
      lockKey = `${dataKey}:lease`;
      const cached = await redis.get(dataKey);
      if (cached !== null && (await this.generation(prefix)) === generation) {
        recordReliabilityMetric("invoice_cache_hits");
        return { value: cached, state: "HIT" };
      }
      acquired = (await redis.set(lockKey, token, "PX", this.leaseMs, "NX")) === "OK";
    } catch {
      recordReliabilityMetric("invoice_cache_fallbacks");
      return this.localPopulate(prefix, key, ttl, loader);
    }
    recordReliabilityMetric("invoice_cache_misses");
    if (!acquired) recordReliabilityMetric("invoice_cache_coalesced");
    while (!acquired) {
      if (Date.now() >= deadline) throw this.busy("Invoice cache lease wait timed out");
      await new Promise((resolve) => setTimeout(resolve, 25));
      try {
        if ((await this.generation(prefix)) !== generation)
          throw this.busy("Invoice cache context changed during wait");
        const cached = await redis.get(dataKey);
        if (cached !== null && (await this.generation(prefix)) === generation)
          return { value: cached, state: "COALESCED" };
        acquired = (await redis.set(lockKey, token, "PX", this.leaseMs, "NX")) === "OK";
      } catch (error) {
        if (error instanceof AppError) throw error;
        recordReliabilityMetric("invoice_cache_fallbacks");
        return this.localPopulate(prefix, key, ttl, loader);
      }
    }
    try {
      // A predecessor can publish between our miss and acquiring the lease.
      const cached = await redis.get(dataKey);
      if (cached !== null && (await this.generation(prefix)) === generation)
        return { value: cached, state: "HIT" };
      const value = await this.loadBounded(key, loader);
      if (Date.now() < this.redisBypassUntil)
        throw this.busy("Invoice cache invalidation is awaiting expiry");
      const published = await redis.eval(
        PUBLISH_FILL,
        3,
        lockKey,
        dataKey,
        `${prefix}:generation`,
        token,
        generation,
        value,
        ttl
      );
      if (published !== 1) {
        recordReliabilityMetric("invoice_cache_fenced_fills");
        throw this.busy("Invoice cache lease expired or context changed during population");
      }
      return { value, state: "MISS" };
    } finally {
      try {
        await redis.eval(RELEASE_LEASE, 1, lockKey, token);
      } catch {
        /* Lease expires independently. */
      }
    }
  }

  /**
   * Graceful disconnect on shutdown.
   */
  async disconnect(): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch {
        this.redis.disconnect();
      }
    }
  }

  // --- Internal Redis & In-Memory Fallback Get/Set/Del ---

  private async get(key: string): Promise<string | null> {
    // A Redis miss is authoritative. Never revive a process-local copy that
    // could have been invalidated by another API instance.
    if (this.redis) {
      if (Date.now() < this.redisBypassUntil) return null;
      try {
        return await this.redis.get(key);
      } catch {
        return null;
      }
    }
    const entry = this.memoryFallback.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.memoryFallback.delete(key);
      return null;
    }
    return entry.value;
  }

  private async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.redis) {
      if (Date.now() < this.redisBypassUntil) return;
      await this.redis.setex(key, ttlSeconds, value);
      return;
    }
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error("Invalid cache TTL");
    for (const [entryKey, entry] of this.memoryFallback) {
      if (Date.now() >= entry.expiresAt) this.memoryFallback.delete(entryKey);
    }
    this.memoryFallback.delete(key);
    while (this.memoryFallback.size >= this.maxEntries) {
      this.memoryFallback.delete(this.memoryFallback.keys().next().value!);
    }
    this.memoryFallback.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
}

export function createInvoiceCacheService(options: InvoiceCacheOptions = {}): InvoiceCacheService {
  return new InvoiceCacheService(options);
}
