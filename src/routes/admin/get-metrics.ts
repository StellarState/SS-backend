import { Request, Response } from "express";
import { MetricsService } from "@/services/metrics.service";

interface GetMetricsQuery {
  from?: string;
  to?: string;
}

// GET /admin/metrics?from=&to=
export async function getMetrics(
  req: Request<unknown, unknown, unknown, GetMetricsQuery>,
  res: Response,
  metricsService: MetricsService,
) {
  try {
    const adminKey = req.headers["x-admin-key"];
    if (adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { from, to } = req.query;

    const metrics = await metricsService.getPlatformMetrics({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });

    return res.json({ success: true, data: metrics });
  } catch (err: unknown) {
    const appErr = err as { status?: number; code?: string; message?: string };
    return res.status(appErr.status ?? 500).json({
      error: {
        code: appErr.code ?? "INTERNAL_ERROR",
        message: appErr.message ?? "Internal server error",
      },
    });
  }
}
