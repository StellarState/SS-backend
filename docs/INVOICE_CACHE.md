# Invoice cache isolation and bounded fills

All invoice cache keys are constructed by `src/lib/cache-key.ts`. Keys include
schema version, validated Stellar network, tenant and wallet scope. The current
application is single tenant (`default`); the authenticated account ID identifies
its Stellar wallet. A future tenant must be supplied by trusted server context,
not an arbitrary request header. Hashing components prevents separator/glob
collisions. General on-chain projection caches also include the request network.
Background jobs use the configured `STELLAR_NETWORK`.

Changing `CACHE_SCHEMA_VERSION` isolates incompatible stored values. Invoice
keys share a Redis hash tag per context, allowing lease publication and generation
checks to run atomically on Redis Cluster. Mutations increment a context generation
and invalidate every list/detail/filter/page variant for that wallet, network,
tenant and schema. Other contexts remain usable. Superseded keys expire through
their normal TTL; no Redis KEYS or SCAN is needed. Generation keys are compact,
durable invalidation fences and must not be evicted independently of data keys:
configure Redis `volatile-lru`/`volatile-lfu` (data keys expire, fences do not),
or `noeviction`. Memory caches and their context tracking are bounded.

## Stampede protection

Controller list/detail reads use `getOrLoadInvoicesList`/`getOrLoadInvoiceDetail`.
Each process coalesces requests by context/key; Redis `SET NX PX` leases coalesce
fills across API instances. After loading, an atomic Lua script checks ownership
and the context generation before storing the value. An expired owner cannot
serve or overwrite its result. Release also compares ownership. Mutation races
reject the old fill with retryable HTTP 503 `CACHE_FILL_BUSY`.

Defaults: 64 distinct in-flight fills, 1,000 waiting requests per key, 5-second
Redis lease/wait bound, 3-second load timeout and 1,000 memory entries. Constructor
options support tuning within hard limits. A timed-out database operation retains
its capacity and per-key exclusion until it actually settles. Requests exceeding
capacity or the wait deadline receive 503; they do not bypass coalescing with a
second database query. Redis client commands have a 1-second timeout.

Redis outage fallback uses bounded local coalescing and returns a database result
without persisting an authoritative Redis fallback copy. A Redis miss never
revives a process-local value. A failed post-commit invalidation keeps the mutation successful and bypasses Redis
on that process until the longest cache TTL plus lease duration expires. In-flight
fills are fenced locally during that interval. Distributed uniqueness cannot be guaranteed while
Redis is unreachable; database concurrency remains bounded per process. No stale
invoice response is served after TTL or lease expiry, and stale-while-revalidate
is deliberately disabled for these mutable, authenticated responses. When Redis
is omitted entirely, a bounded local cache uses strict TTL expiry.

`X-Cache` reports `HIT`, `MISS` or `COALESCED`. The metrics endpoint exports
`stellarsettle_invoice_cache_{hits,misses,coalesced,populations,fallbacks,
rejected_requests,fenced_fills,invalidation_failures}_total` without wallet/key labels. Compare
populations to misses and monitor rejected requests before raising limits.

## Reproducible load checks

Run `npm test -- --runInBand invoice-cache cache-context` for in-memory/mock
coverage, including cross-network isolation, precise invalidation, schema
separation, loader failure, timeout capacity and mutation races.
For actual Redis lease expiry and distributed fencing:

```bash
INVOICE_CACHE_TEST_REDIS_URL=redis://127.0.0.1:6379/13 \
  npm test -- --runInBand invoice-cache-stampede
```

Use a disposable Redis database: the test flushes that database. The local load
case sends 200 concurrent requests and asserts one database load (99.5% reduction).
The distributed case sends 80 requests through eight service instances and
asserts one shared population. Both print measured fan-out; timing is not used
as a performance assertion. Deploy only after these checks and migration checks.
