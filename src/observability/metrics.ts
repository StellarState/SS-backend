const HTTP_DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

interface RequestMetricLabels {
  method: string;
  route: string;
  statusClass: string;
}

interface HistogramMetric {
  labels: RequestMetricLabels;
  bucketCounts: number[];
  count: number;
  sum: number;
}

interface CounterMetric {
  labels: RequestMetricLabels;
  value: number;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function buildLabelSet(labels: RequestMetricLabels): string {
  return `method="${escapeLabelValue(labels.method)}",route="${escapeLabelValue(
    labels.route,
  )}",status_class="${escapeLabelValue(labels.statusClass)}"`;
}

function buildMetricKey(labels: RequestMetricLabels): string {
  return `${labels.method}|${labels.route}|${labels.statusClass}`;
}

const SETTLEMENT_LATENCY_BUCKETS_SECONDS = [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 21600, 86400];

export type SettlementStage = "pending" | "in_progress";
export type SettlementOutcome = "completed" | "failed";

const SETTLEMENT_STAGES: SettlementStage[] = ["pending", "in_progress"];
const SETTLEMENT_OUTCOMES: SettlementOutcome[] = ["completed", "failed"];

class SecondsHistogram {
  private readonly bucketCounts = SETTLEMENT_LATENCY_BUCKETS_SECONDS.map(() => 0);
  private count = 0;
  private sum = 0;

  observe(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.count += 1;
    this.sum += seconds;
    const index = SETTLEMENT_LATENCY_BUCKETS_SECONDS.findIndex((bound) => seconds <= bound);
    if (index >= 0) this.bucketCounts[index] += 1;
  }

  render(name: string, help: string): string[] {
    const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];
    let cumulative = 0;
    SETTLEMENT_LATENCY_BUCKETS_SECONDS.forEach((bound, index) => {
      cumulative += this.bucketCounts[index];
      lines.push(`${name}_bucket{le="${bound}"} ${cumulative}`);
    });
    lines.push(
      `${name}_bucket{le="+Inf"} ${this.count}`,
      `${name}_sum ${this.sum}`,
      `${name}_count ${this.count}`,
    );
    return lines;
  }
}

export class MetricsRegistry {
  private readonly requestCounters = new Map<string, CounterMetric>();
  private readonly requestDurationHistograms = new Map<string, HistogramMetric>();
  private readonly settlementStageCounts = new Map<SettlementStage, number>();
  private readonly settlementOutcomeCounts = new Map<SettlementOutcome, number>();
  private settlementRetryCount = 0;
  private settlementOldestPendingAgeSeconds = 0;
  private readonly settlementQueueLatency = new SecondsHistogram();

  adjustSettlementStageCount(stage: SettlementStage, delta: number): void {
    const next = Math.max(0, (this.settlementStageCounts.get(stage) ?? 0) + delta);
    this.settlementStageCounts.set(stage, next);
  }

  setSettlementStageCount(stage: SettlementStage, count: number): void {
    this.settlementStageCounts.set(stage, Math.max(0, count));
  }

  setSettlementOldestPendingAgeSeconds(seconds: number): void {
    this.settlementOldestPendingAgeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  }

  incrementSettlementOutcome(outcome: SettlementOutcome): void {
    this.settlementOutcomeCounts.set(outcome, (this.settlementOutcomeCounts.get(outcome) ?? 0) + 1);
  }

  incrementSettlementRetry(): void {
    this.settlementRetryCount += 1;
  }

  observeSettlementQueueLatency(seconds: number): void {
    this.settlementQueueLatency.observe(seconds);
  }

  recordHttpRequest(input: RequestMetricLabels & { durationMs: number }): void {
    const labels: RequestMetricLabels = {
      method: input.method,
      route: input.route,
      statusClass: input.statusClass,
    };
    const key = buildMetricKey(labels);
    const requestCounter = this.requestCounters.get(key) ?? {
      labels,
      value: 0,
    };

    requestCounter.value += 1;
    this.requestCounters.set(key, requestCounter);

    const histogram = this.requestDurationHistograms.get(key) ?? {
      labels,
      bucketCounts: HTTP_DURATION_BUCKETS_MS.map(() => 0),
      count: 0,
      sum: 0,
    };

    histogram.count += 1;
    histogram.sum += input.durationMs;

    for (let index = 0; index < HTTP_DURATION_BUCKETS_MS.length; index += 1) {
      if (input.durationMs <= HTTP_DURATION_BUCKETS_MS[index]) {
        histogram.bucketCounts[index] += 1;
        break;
      }
    }

    this.requestDurationHistograms.set(key, histogram);
  }

  renderPrometheusMetrics(): string {
    const lines = [
      "# HELP stellarsettle_http_requests_total Total completed HTTP requests.",
      "# TYPE stellarsettle_http_requests_total counter",
    ];

    for (const metric of this.requestCounters.values()) {
      lines.push(
        `stellarsettle_http_requests_total{${buildLabelSet(metric.labels)}} ${metric.value}`,
      );
    }

    lines.push(
      "# HELP stellarsettle_http_request_duration_ms HTTP request duration in milliseconds.",
      "# TYPE stellarsettle_http_request_duration_ms histogram",
    );

    for (const metric of this.requestDurationHistograms.values()) {
      let cumulativeCount = 0;

      for (let index = 0; index < HTTP_DURATION_BUCKETS_MS.length; index += 1) {
        cumulativeCount += metric.bucketCounts[index];
        lines.push(
          `stellarsettle_http_request_duration_ms_bucket{${buildLabelSet(
            metric.labels,
          )},le="${HTTP_DURATION_BUCKETS_MS[index]}"} ${cumulativeCount}`,
        );
      }

      lines.push(
        `stellarsettle_http_request_duration_ms_bucket{${buildLabelSet(
          metric.labels,
        )},le="+Inf"} ${metric.count}`,
        `stellarsettle_http_request_duration_ms_sum{${buildLabelSet(metric.labels)}} ${metric.sum}`,
        `stellarsettle_http_request_duration_ms_count{${buildLabelSet(metric.labels)}} ${metric.count}`,
      );
    }

    lines.push(...this.renderSettlementMetrics());

    lines.push(
      "# HELP stellarsettle_process_uptime_seconds Process uptime in seconds.",
      "# TYPE stellarsettle_process_uptime_seconds gauge",
      `stellarsettle_process_uptime_seconds ${process.uptime()}`,
    );

    return `${lines.join("\n")}\n`;
  }

  private renderSettlementMetrics(): string[] {
    const lines = [
      "# HELP stellarsettle_settlement_stage_count Settlements currently in each stage.",
      "# TYPE stellarsettle_settlement_stage_count gauge",
    ];
    for (const stage of SETTLEMENT_STAGES) {
      lines.push(
        `stellarsettle_settlement_stage_count{stage="${stage}"} ${this.settlementStageCounts.get(stage) ?? 0}`,
      );
    }

    lines.push(
      "# HELP stellarsettle_settlement_oldest_pending_age_seconds Age in seconds of the oldest matured settlement still pending.",
      "# TYPE stellarsettle_settlement_oldest_pending_age_seconds gauge",
      `stellarsettle_settlement_oldest_pending_age_seconds ${this.settlementOldestPendingAgeSeconds}`,
      "# HELP stellarsettle_settlement_transitions_total Settlement flows reaching a terminal outcome.",
      "# TYPE stellarsettle_settlement_transitions_total counter",
    );
    for (const outcome of SETTLEMENT_OUTCOMES) {
      lines.push(
        `stellarsettle_settlement_transitions_total{outcome="${outcome}"} ${this.settlementOutcomeCounts.get(outcome) ?? 0}`,
      );
    }

    lines.push(
      "# HELP stellarsettle_settlement_retries_total Matured settlements that failed and will be retried.",
      "# TYPE stellarsettle_settlement_retries_total counter",
      `stellarsettle_settlement_retries_total ${this.settlementRetryCount}`,
      ...this.settlementQueueLatency.render(
        "stellarsettle_settlement_queue_latency_seconds",
        "Seconds between a settlement's due date and the start of its processing.",
      ),
    );

    return lines;
  }
}

export function getMetricsContentType(): string {
  return PROMETHEUS_CONTENT_TYPE;
}
