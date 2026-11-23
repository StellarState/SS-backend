import "tsconfig-paths/register";
import dataSource from "../src/config/database";
import { maintainEventRetention } from "../src/maintenance/event-retention";
import { MetricsRegistry } from "../src/observability/metrics";
import { setReliabilityMetricsRegistry } from "../src/observability/reliability-metrics";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL || process.env.NODE_ENV === "development") {
    throw new Error("Event retention requires an explicit PostgreSQL DATABASE_URL");
  }
  const metrics = new MetricsRegistry();
  setReliabilityMetricsRegistry(metrics);
  await dataSource.initialize();
  try {
    for (const source of ["soroban_event_logs", "webhook_delivery_logs"] as const) {
      console.log(JSON.stringify(await maintainEventRetention(source, dataSource)));
    }
    console.log(metrics.renderPrometheusMetrics());
  } finally {
    setReliabilityMetricsRegistry(undefined);
    await dataSource.destroy();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Event maintenance failed");
  process.exitCode = 1;
});
