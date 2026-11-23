import type { MetricsRegistry } from "./metrics";

let registry: MetricsRegistry | undefined;
export function setReliabilityMetricsRegistry(value: MetricsRegistry | undefined): void {
  registry = value;
}

/** Callers use fixed names: wallet, event and correlation IDs belong in logs. */
export function recordReliabilityMetric(name: string, count = 1): void {
  if (!registry) return;
  registry.addCounter(`stellarsettle_${name}`, count);
}
