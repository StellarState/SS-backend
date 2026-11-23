import { createHash } from "crypto";
import type { NetworkAwareRequest, StellarNetworkName } from "../types/network";
import { getRequestContext } from "../observability/request-context";

export const CACHE_SCHEMA_VERSION = "2";
export interface CacheContext {
  network: StellarNetworkName;
  tenantId: string;
  walletScope: string;
}

export function defaultCacheNetwork(): StellarNetworkName {
  return (
    getRequestContext()?.stellarNetwork ??
    (process.env.STELLAR_NETWORK === "testnet" ? "testnet" : "mainnet")
  );
}

export function invoiceCacheContext(req: NetworkAwareRequest, sellerId: string): CacheContext {
  // The authenticated account ID is the stable scope of its Stellar wallet.
  // This service is single tenant; future tenants must supply trusted tenant IDs.
  return {
    network: req.stellarNetwork?.network ?? defaultCacheNetwork(),
    tenantId: "default",
    walletScope: sellerId,
  };
}

export function cacheContextPrefix(
  namespace: string,
  context: CacheContext,
  schemaVersion = CACHE_SCHEMA_VERSION
): string {
  if (
    !["mainnet", "testnet"].includes(context.network) ||
    !context.tenantId ||
    !context.walletScope ||
    !schemaVersion ||
    !namespace
  ) {
    throw new Error("Cache keys require network, tenant, wallet scope and schema version");
  }
  // Hash each arbitrary component: delimiters and glob characters cannot escape
  // their scope. The Redis hash tag puts a context's fence and keys in one slot.
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        namespace,
        schemaVersion,
        context.network,
        context.tenantId,
        context.walletScope,
      ])
    )
    .digest("hex");
  return `ss:${schemaVersion}:${context.network}:{${scope}}`;
}

export function cacheKey(
  namespace: string,
  context: CacheContext,
  parts: readonly unknown[],
  schemaVersion = CACHE_SCHEMA_VERSION
): string {
  const suffix = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${cacheContextPrefix(namespace, context, schemaVersion)}:${suffix}`;
}
