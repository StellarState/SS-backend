import type { MetricsRegistry } from "../observability/metrics";

let registry: MetricsRegistry | undefined;

export function setSettlementMetricsRegistry(next: MetricsRegistry | undefined): void {
  registry = next;
}

function record(update: (metrics: MetricsRegistry) => void): void {
  if (!registry) return;
  try {
    update(registry);
  } catch {
    // Metrics must never fail a settlement or a health check.
  }
}

export function recordSettlementStarted(): void {
  record((metrics) => metrics.adjustSettlementStageCount("in_progress", 1));
}

export function recordSettlementCompleted(): void {
  record((metrics) => {
    metrics.adjustSettlementStageCount("in_progress", -1);
    metrics.incrementSettlementOutcome("completed");
  });
}

export function recordSettlementFailed(): void {
  record((metrics) => {
    metrics.adjustSettlementStageCount("in_progress", -1);
    metrics.incrementSettlementOutcome("failed");
  });
}

export function recordSettlementRetry(): void {
  record((metrics) => metrics.incrementSettlementRetry());
}

export function recordSettlementQueueLatency(seconds: number): void {
  record((metrics) => metrics.observeSettlementQueueLatency(seconds));
}

export function recordPendingSettlementBacklog(input: {
  count: number;
  oldestAgeSeconds: number;
}): void {
  record((metrics) => {
    metrics.setSettlementStageCount("pending", input.count);
    metrics.setSettlementOldestPendingAgeSeconds(input.oldestAgeSeconds);
  });
}
