import request from "supertest";
import { createApp } from "../src/app";
import type { AppLogger, LogMetadata } from "../src/observability/logger";
import { MetricsRegistry } from "../src/observability/metrics";
import type { AuthService } from "../src/services/auth.service";

interface LogEntry {
  level: "info" | "warn" | "error";
  message: string;
  metadata: LogMetadata;
}

class CaptureLogger implements AppLogger {
  constructor(
    readonly entries: LogEntry[] = [],
    private readonly defaultMetadata: LogMetadata = {},
  ) {}

  info(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({
      level: "info",
      message,
      metadata: {
        ...this.defaultMetadata,
        ...metadata,
      },
    });
  }

  warn(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({
      level: "warn",
      message,
      metadata: {
        ...this.defaultMetadata,
        ...metadata,
      },
    });
  }

  error(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({
      level: "error",
      message,
      metadata: {
        ...this.defaultMetadata,
        ...metadata,
      },
    });
  }

  child(metadata: LogMetadata): AppLogger {
    return new CaptureLogger(this.entries, {
      ...this.defaultMetadata,
      ...metadata,
    });
  }
}

function createAuthServiceStub(): AuthService {
  return {
    createChallenge: async () => {
      throw new Error("Not implemented.");
    },
    verifyChallenge: async () => {
      throw new Error("Not implemented.");
    },
    getCurrentUser: async () => {
      throw new Error("Not implemented.");
    },
  } as unknown as AuthService;
}

describe("Observability", () => {
  it("assigns distinct request IDs and includes them in request lifecycle logs", async () => {
    const logger = new CaptureLogger();
    const app = createApp({
      authService: createAuthServiceStub(),
      logger,
      metricsEnabled: true,
      metricsRegistry: new MetricsRegistry(),
    });

    const [firstResponse, secondResponse] = await Promise.all([
      request(app).get("/health").expect(200),
      request(app).get("/health").expect(200),
    ]);

    expect(firstResponse.headers["x-request-id"]).toEqual(expect.any(String));
    expect(secondResponse.headers["x-request-id"]).toEqual(expect.any(String));
    expect(firstResponse.headers["x-request-id"]).not.toBe(
      secondResponse.headers["x-request-id"],
    );

    const requestLogs = logger.entries.filter(
      (entry) => entry.level === "info" && entry.message === "HTTP request completed.",
    );

    expect(requestLogs).toHaveLength(2);
    expect(requestLogs.map((entry) => entry.metadata.requestId)).toEqual(
      expect.arrayContaining([
        firstResponse.headers["x-request-id"],
        secondResponse.headers["x-request-id"],
      ]),
    );
  });

  it("reuses X-Request-Id when a client provides one", async () => {
    const app = createApp({
      authService: createAuthServiceStub(),
      logger: new CaptureLogger(),
      metricsEnabled: true,
      metricsRegistry: new MetricsRegistry(),
    });

    const response = await request(app)
      .get("/health")
      .set("X-Request-Id", "client-request-id")
      .expect(200);

    expect(response.headers["x-request-id"]).toBe("client-request-id");
    expect(response.body.requestId).toBe("client-request-id");
  });

  it("exposes Prometheus metrics for matched routes and unmatched requests", async () => {
    const app = createApp({
      authService: createAuthServiceStub(),
      logger: new CaptureLogger(),
      metricsEnabled: true,
      metricsRegistry: new MetricsRegistry(),
    });

    await request(app).get("/health").expect(200);
    await request(app).get("/api/v1/auth/me").expect(401);
    await request(app).get("/does-not-exist").expect(404);

    const metricsResponse = await request(app).get("/metrics").expect(200);

    expect(metricsResponse.headers["content-type"]).toContain("text/plain");
    expect(metricsResponse.text).toContain(
      "# TYPE stellarsettle_http_requests_total counter",
    );
    expect(metricsResponse.text).toContain(
      'stellarsettle_http_requests_total{method="GET",route="/health",status_class="2xx"} 1',
    );
    expect(metricsResponse.text).toContain(
      'stellarsettle_http_requests_total{method="GET",route="/api/v1/auth/me",status_class="4xx"} 1',
    );
    expect(metricsResponse.text).toContain(
      'stellarsettle_http_requests_total{method="GET",route="unmatched",status_class="4xx"} 1',
    );
    expect(metricsResponse.text).toContain(
      "# TYPE stellarsettle_http_request_duration_ms histogram",
    );
    expect(metricsResponse.text).toContain(
      "# TYPE stellarsettle_process_uptime_seconds gauge",
    );
  });
});
