import { MetricsRegistry } from "@/observability/metrics";
import {
  recordPendingSettlementBacklog,
  recordSettlementCompleted,
  recordSettlementFailed,
  recordSettlementQueueLatency,
  recordSettlementRetry,
  recordSettlementStarted,
  setSettlementMetricsRegistry,
} from "@/lib/settlement-metrics";

const WALLET = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function sampleValue(output: string, line: string): number {
  const found = output.split("\n").find((entry) => entry.startsWith(line));
  if (!found) throw new Error(`metric line not found: ${line}`);
  return Number(found.slice(line.length).trim());
}

describe("settlement metrics", () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
    setSettlementMetricsRegistry(registry);
  });

  afterEach(() => {
    setSettlementMetricsRegistry(undefined);
  });

  it("tracks start and completion so in-progress returns to zero", () => {
    recordSettlementStarted();
    expect(
      sampleValue(registry.renderPrometheusMetrics(), 'stellarsettle_settlement_stage_count{stage="in_progress"} '),
    ).toBe(1);

    recordSettlementCompleted();
    const output = registry.renderPrometheusMetrics();
    expect(sampleValue(output, 'stellarsettle_settlement_stage_count{stage="in_progress"} ')).toBe(0);
    expect(sampleValue(output, 'stellarsettle_settlement_transitions_total{outcome="completed"} ')).toBe(1);
    expect(sampleValue(output, 'stellarsettle_settlement_transitions_total{outcome="failed"} ')).toBe(0);
  });

  it("counts a failure without leaving in-progress inflated, and records a retry separately", () => {
    recordSettlementStarted();
    recordSettlementFailed();
    recordSettlementRetry();

    const output = registry.renderPrometheusMetrics();
    expect(sampleValue(output, 'stellarsettle_settlement_stage_count{stage="in_progress"} ')).toBe(0);
    expect(sampleValue(output, 'stellarsettle_settlement_transitions_total{outcome="failed"} ')).toBe(1);
    expect(sampleValue(output, "stellarsettle_settlement_retries_total ")).toBe(1);
  });

  it("never lets in-progress go negative on an unmatched completion", () => {
    recordSettlementCompleted();
    expect(
      sampleValue(registry.renderPrometheusMetrics(), 'stellarsettle_settlement_stage_count{stage="in_progress"} '),
    ).toBe(0);
  });

  it("exposes pending backlog, oldest age and queue latency histogram", () => {
    recordPendingSettlementBacklog({ count: 3, oldestAgeSeconds: 420 });
    recordSettlementQueueLatency(7);
    recordSettlementQueueLatency(90);

    const output = registry.renderPrometheusMetrics();
    expect(sampleValue(output, 'stellarsettle_settlement_stage_count{stage="pending"} ')).toBe(3);
    expect(sampleValue(output, "stellarsettle_settlement_oldest_pending_age_seconds ")).toBe(420);
    expect(sampleValue(output, "stellarsettle_settlement_queue_latency_seconds_count ")).toBe(2);
    expect(sampleValue(output, "stellarsettle_settlement_queue_latency_seconds_sum ")).toBe(97);
    expect(sampleValue(output, 'stellarsettle_settlement_queue_latency_seconds_bucket{le="+Inf"} ')).toBe(2);
    expect(output).toContain("# TYPE stellarsettle_settlement_queue_latency_seconds histogram");
    expect(output).toContain("# TYPE stellarsettle_settlement_stage_count gauge");
  });

  it("is a no-op when no registry is configured", () => {
    setSettlementMetricsRegistry(undefined);
    expect(() => {
      recordSettlementStarted();
      recordSettlementCompleted();
      recordSettlementFailed();
      recordSettlementRetry();
      recordSettlementQueueLatency(1);
      recordPendingSettlementBacklog({ count: 1, oldestAgeSeconds: 1 });
    }).not.toThrow();
  });

  it("keeps wallet addresses and invoice identifiers out of rendered output", () => {
    recordSettlementStarted();
    recordSettlementQueueLatency(5);
    recordSettlementCompleted();

    const output = registry.renderPrometheusMetrics();
    expect(output).not.toContain(WALLET);
    expect(output).not.toMatch(/G[A-Z2-7]{55}/);
    expect(output).not.toContain("invoice");
  });
});
